import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEVICE_TOKEN_TTL_SECONDS,
  signDeviceToken,
  verifyDeviceToken,
} from "@pistachio/sync-protocol";
import * as schema from "../src/db/schema.js";
import { generateSigningKeys, type SigningKeys } from "../src/keys-provider.js";
import {
  authed,
  challengeFor,
  desktopAccount,
  deviceLogin,
  enrollDesktop,
  enrollRequest,
  json,
  jsonInit,
  makeHarness,
  newDeviceKeys,
  signChallenge,
  signup,
  type Harness,
} from "./helpers.js";

let h: Harness;
let otherSigning: SigningKeys;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  h = await makeHarness();
  otherSigning = await generateSigningKeys();
});

describe("GET /v1/auth/jwks", () => {
  it("serves the raw Ed25519 public key without auth", async () => {
    const res = await h.request("/v1/auth/jwks");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      alg: "EdDSA",
      format: "raw-ed25519-base64",
      publicKey: h.signing.publicKeyBase64(),
    });
  });
});

describe("POST /v1/devices/enroll", () => {
  it("verifies the proof against the public key in the body and mints a device token", async () => {
    const { userId, bootstrapToken } = await signup(h);
    const keys = await newDeviceKeys();
    const res = await enrollRequest(h, bootstrapToken, keys);
    expect(res.status).toBe(201);
    const out = await json<{ device: Record<string, unknown>; token: string; exp: number }>(res);
    expect(out.device).toMatchObject({
      id: keys.deviceId,
      name: "MacBook",
      platform: "macos",
      devicePublicKey: keys.devicePublicKey,
      agreementPublicKey: keys.agreementPublicKey,
      revokedAt: null,
    });
    expect(typeof out.device["createdAt"]).toBe("string");
    const verified = await verifyDeviceToken(h.signing.verifyKey, out.token, nowSeconds());
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.claims).toMatchObject({ sub: userId, did: keys.deviceId });
    expect(verified.claims.exp - verified.claims.iat).toBe(DEVICE_TOKEN_TTL_SECONDS);
    expect(out.exp).toBe(verified.claims.exp);
    const audits = await h.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.userId, userId), eq(schema.auditEvents.kind, "device.enrolled")));
    expect(audits[0]?.actorDeviceId).toBe(keys.deviceId);
  });

  it("rejects a signature that does not verify under the body key", async () => {
    const { bootstrapToken } = await signup(h);
    const keys = await newDeviceKeys();
    const stranger = await newDeviceKeys();
    const challenge = await challengeFor(h, keys.deviceId);
    const signature = await signChallenge({ ...stranger, deviceId: keys.deviceId }, challenge);
    const res = await enrollRequest(h, bootstrapToken, keys, { challenge, signature });
    expect(res.status).toBe(401);
    expect((await json(res))["reason"]).toBe("bad_signature");
  });

  it("consumes the challenge: a replay is challenge_expired", async () => {
    const { bootstrapToken } = await signup(h);
    const keys = await newDeviceKeys();
    const challenge = await challengeFor(h, keys.deviceId);
    const signature = await signChallenge(keys, challenge);
    const other = await newDeviceKeys();
    // Wrong body key first: the challenge is consumed even though the proof fails.
    const first = await enrollRequest(h, bootstrapToken, keys, {
      challenge,
      signature,
      devicePublicKey: other.devicePublicKey,
    });
    expect(first.status).toBe(401);
    const replay = await enrollRequest(h, bootstrapToken, keys, { challenge, signature });
    expect(replay.status).toBe(401);
    expect((await json(replay))["reason"]).toBe("challenge_expired");
  });

  it("refuses a device bearer (bootstrap_required) and platform cloud", async () => {
    const account = await desktopAccount(h);
    const keys = await newDeviceKeys();
    const withDevice = await enrollRequest(h, account.token, keys);
    expect(withDevice.status).toBe(403);
    expect((await json(withDevice))["error"]).toBe("bootstrap_required");
    const cloud = await enrollRequest(h, account.bootstrapToken, keys, { platform: "cloud" });
    expect(cloud.status).toBe(400);
    expect((await json(cloud))["error"]).toBe("platform_not_allowed");
  });

  it("409s a taken device id and an already-enrolled or revoked public key", async () => {
    const a = await desktopAccount(h);
    const b = await signup(h);
    const sameId = await newDeviceKeys();
    sameId.deviceId = a.deviceId;
    const taken = await enrollRequest(h, b.bootstrapToken, sameId);
    expect(taken.status).toBe(409);
    expect((await json(taken))["error"]).toBe("device_id_taken");

    const sameKey = { ...a.keys, deviceId: randomUUID() };
    const enrolled = await enrollRequest(h, b.bootstrapToken, sameKey);
    expect(enrolled.status).toBe(409);
    expect((await json(enrolled))["error"]).toBe("device_already_enrolled");

    await h.request(`/v1/devices/${a.deviceId}/revoke`, authed(a.token, "POST"));
    const revoked = await enrollRequest(h, b.bootstrapToken, { ...a.keys, deviceId: randomUUID() });
    expect(revoked.status).toBe(409);
    expect((await json(revoked))["error"]).toBe("device_revoked");
  });

  it("400s a public key that is not 32 bytes and a malformed body", async () => {
    const { bootstrapToken } = await signup(h);
    const keys = await newDeviceKeys();
    const short = await enrollRequest(h, bootstrapToken, keys, { devicePublicKey: "AAAA" });
    expect(short.status).toBe(400);
    expect((await json(short))["error"]).toBe("invalid_body");
    const empty = await h.request("/v1/devices/enroll", { method: "POST", headers: { authorization: `Bearer ${bootstrapToken}` } });
    expect(empty.status).toBe(400);
  });
});

describe("device-login", () => {
  it("mints a token from a signed challenge and authenticates with it", async () => {
    const account = await desktopAccount(h);
    const { token } = await deviceLogin(h, account.keys);
    const me = await h.request("/v1/me", authed(token));
    expect(me.status).toBe(200);
    expect((await json(me))["userId"]).toBe(account.userId);
  });

  it("rejects the wrong key, a replayed proof, an unknown device, and a revoked device", async () => {
    const account = await desktopAccount(h);
    const stranger = await newDeviceKeys();
    const challenge = await challengeFor(h, account.deviceId);
    const forged = await signChallenge({ ...stranger, deviceId: account.deviceId }, challenge);
    const bad = await h.request(
      "/v1/auth/device-login",
      jsonInit("POST", { deviceId: account.deviceId, challenge, signature: forged }),
    );
    expect(bad.status).toBe(401);
    expect((await json(bad))["reason"]).toBe("bad_signature");

    const fresh = await challengeFor(h, account.deviceId);
    const signature = await signChallenge(account.keys, fresh);
    const ok = await h.request("/v1/auth/device-login", jsonInit("POST", { deviceId: account.deviceId, challenge: fresh, signature }));
    expect(ok.status).toBe(200);
    const replay = await h.request("/v1/auth/device-login", jsonInit("POST", { deviceId: account.deviceId, challenge: fresh, signature }));
    expect(replay.status).toBe(401);
    expect((await json(replay))["reason"]).toBe("challenge_expired");

    const ghost = await newDeviceKeys();
    const ghostChallenge = await challengeFor(h, ghost.deviceId);
    const unknown = await h.request(
      "/v1/auth/device-login",
      jsonInit("POST", { deviceId: ghost.deviceId, challenge: ghostChallenge, signature: await signChallenge(ghost, ghostChallenge) }),
    );
    expect(unknown.status).toBe(401);
    expect((await json(unknown))["reason"]).toBe("unknown_device");

    await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(account.token, "POST"));
    const afterRevoke = await challengeFor(h, account.deviceId);
    const revoked = await h.request(
      "/v1/auth/device-login",
      jsonInit("POST", { deviceId: account.deviceId, challenge: afterRevoke, signature: await signChallenge(account.keys, afterRevoke) }),
    );
    expect(revoked.status).toBe(401);
    expect((await json(revoked))["reason"]).toBe("device_revoked");
  });

  it("issues challenges for not-yet-enrolled ids and consumes exactly the presented one", async () => {
    const keys = await newDeviceKeys();
    const c1 = await challengeFor(h, keys.deviceId);
    const c2 = await challengeFor(h, keys.deviceId);
    expect(c1).not.toBe(c2);
    const { bootstrapToken } = await signup(h);
    const res = await enrollRequest(h, bootstrapToken, keys, { challenge: c2, signature: await signChallenge(keys, c2) });
    expect(res.status).toBe(201);
    // c1 is still live: a second enroll with it fails for the id, not the challenge.
    const again = await enrollRequest(h, (await signup(h)).bootstrapToken, keys, { challenge: c1, signature: await signChallenge(keys, c1) });
    expect(again.status).toBe(409);
  });
});

describe("POST /v1/auth/token/refresh", () => {
  it("re-mints a bootstrap token until the first device enrolls, then refuses it", async () => {
    const { userId, bootstrapToken } = await signup(h);
    const res = await h.request("/v1/auth/token/refresh", authed(bootstrapToken, "POST"));
    expect(res.status).toBe(200);
    const out = await json<{ token: string; exp: number }>(res);
    const verified = await verifyDeviceToken(h.signing.verifyKey, out.token, nowSeconds());
    expect(verified.ok && verified.claims.did === userId).toBe(true);
    await enrollDesktop(h, out.token);
    const consumed = await h.request("/v1/auth/token/refresh", authed(bootstrapToken, "POST"));
    expect(consumed.status).toBe(401);
    expect((await json(consumed))["reason"]).toBe("bootstrap_consumed");
  });

  it("re-mints a device token and refuses it once the device is revoked", async () => {
    const account = await desktopAccount(h);
    const res = await h.request("/v1/auth/token/refresh", authed(account.token, "POST"));
    expect(res.status).toBe(200);
    const { token } = await json<{ token: string }>(res);
    const verified = await verifyDeviceToken(h.signing.verifyKey, token, nowSeconds());
    expect(verified.ok && verified.claims.did === account.deviceId).toBe(true);
    await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(account.token, "POST"));
    const dead = await h.request("/v1/auth/token/refresh", authed(token, "POST"));
    expect(dead.status).toBe(401);
    expect((await json(dead))["reason"]).toBe("device_not_active");
  });

  it("401s with no token or a malformed one", async () => {
    expect((await h.request("/v1/auth/token/refresh", { method: "POST" })).status).toBe(401);
    expect((await h.request("/v1/auth/token/refresh", authed("nope", "POST"))).status).toBe(401);
  });
});

describe("bearer verification", () => {
  it("rejects an expired token, a token under another key, and a token naming no user", async () => {
    const account = await desktopAccount(h);
    const iat = nowSeconds() - DEVICE_TOKEN_TTL_SECONDS - 120;
    const expired = await signDeviceToken(h.signing.signingKey, {
      sub: account.userId,
      did: account.deviceId,
      iat,
      exp: iat + DEVICE_TOKEN_TTL_SECONDS,
      jti: randomUUID(),
    });
    expect((await h.request("/v1/me", authed(expired))).status).toBe(401);
    const forged = await signDeviceToken(otherSigning.signingKey, {
      sub: account.userId,
      did: account.deviceId,
      iat: nowSeconds(),
      exp: nowSeconds() + 60,
      jti: randomUUID(),
    });
    expect((await h.request("/v1/me", authed(forged))).status).toBe(401);
    const ghost = randomUUID();
    const noUser = await signDeviceToken(h.signing.signingKey, { sub: ghost, did: ghost, iat: nowSeconds(), exp: nowSeconds() + 60, jti: randomUUID() });
    expect((await h.request("/v1/me", authed(noUser))).status).toBe(401);
    const foreign = await signDeviceToken(h.signing.signingKey, { sub: (await signup(h)).userId, did: account.deviceId, iat: nowSeconds(), exp: nowSeconds() + 60, jti: randomUUID() });
    expect((await h.request("/v1/me", authed(foreign))).status).toBe(401);
    expect((await h.request("/v1/me")).status).toBe(401);
  });

  it("revocation: 401 everywhere, hub notified, egress feed and wrappers updated, idempotent", async () => {
    const account = await desktopAccount(h);
    const login = await json<{ bootstrapToken: string }>(
      await h.request("/v1/auth/password-login", jsonInit("POST", { email: account.email, password: "correct-horse-battery" })),
    );
    const revoker = await enrollDesktop(h, login.bootstrapToken);
    const revokerToken = revoker.token;
    const res = await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(revokerToken, "POST"));
    expect(res.status).toBe(200);
    const out = await json<{ revoked: boolean; affectedOrigins: Array<{ domain: string }> }>(res);
    expect(out.revoked).toBe(true);
    expect(out.affectedOrigins.some((o) => o.domain === "github.com")).toBe(true);
    expect(h.hub.revoked).toContainEqual({ userId: account.userId, deviceId: account.deviceId });
    expect((await h.request("/v1/me", authed(account.token))).status).toBe(401);
    expect((await json(await h.request("/v1/devices", authed(account.token))))["error"]).toBe("unauthorized");
    const feed = await h.db.select().from(schema.egressRevocations).where(eq(schema.egressRevocations.deviceId, account.deviceId));
    expect(feed).toHaveLength(1);
    expect(feed[0]?.credentialId).toBeNull();
    const before = h.hub.revoked.length;
    const again = await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(revokerToken, "POST"));
    expect(again.status).toBe(200);
    expect(h.hub.revoked.length).toBe(before);
    const rows = await h.db.select().from(schema.egressRevocations).where(eq(schema.egressRevocations.deviceId, account.deviceId));
    expect(rows).toHaveLength(1);
  });

  it("repairs a revocation whose hub call failed instead of short-circuiting on revoked_at", async () => {
    const account = await desktopAccount(h);
    const login = await json<{ bootstrapToken: string }>(
      await h.request("/v1/auth/password-login", jsonInit("POST", { email: account.email, password: "correct-horse-battery" })),
    );
    const other = await enrollDesktop(h, login.bootstrapToken);
    expect((await h.request("/v1/egress/provision", authed(account.token, "POST"))).ok).toBe(true);
    const minted = await json<{ credential: { credentialId: string } | null }>(await h.request("/v1/egress", authed(account.token)));
    expect(minted.credential).not.toBeNull();

    h.hub.failRevokeOnce = true;
    const failed = await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(other.token, "POST"));
    expect(failed.status).toBe(500);
    expect(h.hub.revoked.some((r) => r.deviceId === account.deviceId)).toBe(false);

    const repaired = await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(other.token, "POST"));
    expect(repaired.status).toBe(200);
    expect(h.hub.revoked.filter((r) => r.deviceId === account.deviceId)).toHaveLength(1);
    const feed = await h.db.select().from(schema.egressRevocations).where(eq(schema.egressRevocations.deviceId, account.deviceId));
    expect(feed).toHaveLength(1);
    expect(feed[0]?.credentialId).toBeNull();
    const credentials = await h.db
      .select()
      .from(schema.egressCredentials)
      .where(eq(schema.egressCredentials.deviceId, account.deviceId));
    expect(credentials.length).toBeGreaterThan(0);
    expect(credentials.every((row) => row.revokedAt !== null)).toBe(true);
    const audits = await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, account.userId));
    expect(audits.filter((e) => e.kind === "device.revoked")).toHaveLength(1);

    const third = await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(other.token, "POST"));
    expect(third.status).toBe(200);
    expect(h.hub.revoked.filter((r) => r.deviceId === account.deviceId)).toHaveLength(1);
    const stillOne = await h.db.select().from(schema.egressRevocations).where(eq(schema.egressRevocations.deviceId, account.deviceId));
    expect(stillOne).toHaveLength(1);
  });

  it("404s revoking an unknown or foreign device", async () => {
    const a = await desktopAccount(h);
    const b = await desktopAccount(h);
    expect((await h.request(`/v1/devices/${randomUUID()}/revoke`, authed(a.token, "POST"))).status).toBe(404);
    expect((await h.request(`/v1/devices/${b.deviceId}/revoke`, authed(a.token, "POST"))).status).toBe(404);
    expect((await h.request("/v1/devices/not-a-uuid/revoke", authed(a.token, "POST"))).status).toBe(400);
  });
});

describe("devices", () => {
  it("lists devices including revoked rows and renames enrolled ones", async () => {
    const account = await desktopAccount(h);
    const renamed = await h.request(`/v1/devices/${account.deviceId}`, jsonInit("PATCH", { name: "Studio" }, account.token));
    expect(renamed.status).toBe(200);
    expect((await json<{ device: { name: string } }>(renamed)).device.name).toBe("Studio");
    const list = await json<{ devices: Array<Record<string, unknown>> }>(await h.request("/v1/devices", authed(account.token)));
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]).toMatchObject({ id: account.deviceId, name: "Studio", platform: "macos" });
    const other = await desktopAccount(h);
    expect((await h.request(`/v1/devices/${other.deviceId}`, jsonInit("PATCH", { name: "x" }, account.token))).status).toBe(404);
  });
});
