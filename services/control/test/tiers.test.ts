/**
 * Auth tiers (§7.2): bootstrap allowlist, device required, the cloud-device
 * gate, and route families that never cross.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GATEWAY_TOKEN,
  SERVICE_TOKEN,
  authed,
  desktopAccount,
  deviceLogin,
  enableCloud,
  enrollRequest,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  newDeviceKeys,
  signup,
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

describe("bootstrap tokens", () => {
  it("are refused on device-only routes and accepted on the allowlist", async () => {
    const { bootstrapToken } = await signup(h);
    const forbidden: Array<[string, RequestInit]> = [
      ["/v1/me/onboarding/complete", authed(bootstrapToken, "POST")],
      ["/v1/runs", jsonInit("POST", { spaceId: "work", intent: "x" }, bootstrapToken)],
      ["/v1/egress", authed(bootstrapToken)],
      [`/v1/devices/${crypto.randomUUID()}/revoke`, authed(bootstrapToken, "POST")],
      ["/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", wrapped: "AAAA" }] }, bootstrapToken)],
      ["/v1/channels", jsonInit("POST", { name: "c", spaceId: "work" }, bootstrapToken)],
      ["/v1/cloud/enable", jsonInit("POST", { spaceId: "work" }, bootstrapToken)],
      ["/v1/devices", authed(bootstrapToken)],
    ];
    for (const [path, init] of forbidden) {
      const res = await h.request(path, init);
      expect(res.status, path).toBe(403);
      expect((await json(res))["error"], path).toBe("device_required");
    }
    expect((await h.request("/v1/me", authed(bootstrapToken))).status).toBe(200);
    expect((await h.request("/v1/spaces", authed(bootstrapToken))).status).toBe(200);
    expect((await h.request("/v1/spaces/work/wrappers", authed(bootstrapToken))).status).toBe(200);
    expect((await h.request("/v1/spaces/__workspace__/wrappers", authed(bootstrapToken))).status).toBe(200);
    expect((await h.request("/v1/auth/token/refresh", authed(bootstrapToken, "POST"))).status).toBe(200);
    expect((await enrollRequest(h, bootstrapToken, await newDeviceKeys())).status).toBe(201);
  });
});

describe("cloud device tokens", () => {
  it("reach only the read-side allowlist and refresh; everything else is cloud_device_forbidden", async () => {
    const account = await desktopAccount(h);
    await enableCloud(h, account.token);
    const identity = runner.identities.get(account.userId);
    expect(identity).toBeDefined();
    if (!identity) throw new Error("unreachable");
    const { token: cloudToken } = await deviceLogin(h, identity);

    for (const path of ["/v1/me", "/v1/devices", "/v1/spaces", "/v1/spaces/work/wrappers", "/v1/sync/policy", "/v1/egress"]) {
      expect((await h.request(path, authed(cloudToken))).status, path).toBe(200);
    }
    expect((await h.request("/v1/auth/token/refresh", authed(cloudToken, "POST"))).status).toBe(200);

    const forbidden: Array<[string, RequestInit]> = [
      ["/v1/me/onboarding/complete", authed(cloudToken, "POST")],
      ["/v1/runs", jsonInit("POST", { spaceId: "work", intent: "x" }, cloudToken)],
      ["/v1/runs", authed(cloudToken)],
      ["/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", wrapped: "AAAA" }] }, cloudToken)],
      [`/v1/devices/${account.deviceId}/revoke`, authed(cloudToken, "POST")],
      ["/v1/channels", jsonInit("POST", { name: "c", spaceId: "work" }, cloudToken)],
      ["/v1/channels", authed(cloudToken)],
      ["/v1/spaces/work", jsonInit("PUT", { name: "x" }, cloudToken)],
      ["/v1/cloud/enable", jsonInit("POST", { spaceId: "work" }, cloudToken)],
      ["/v1/egress/provision", authed(cloudToken, "POST")],
      ["/v1/auth/password", jsonInit("POST", { currentPassword: "a", newPassword: "b" }, cloudToken)],
    ];
    for (const [path, init] of forbidden) {
      const res = await h.request(path, init);
      expect(res.status, path).toBe(403);
      expect((await json(res))["error"], path).toBe("cloud_device_forbidden");
    }
  });
});

describe("route families", () => {
  it("service and gateway bearers are refused on user routes, and user tokens on service/gateway routes", async () => {
    const account = await desktopAccount(h);
    expect((await h.request("/v1/me", authed(SERVICE_TOKEN))).status).toBe(401);
    expect((await h.request("/v1/me", authed(GATEWAY_TOKEN))).status).toBe(401);
    expect((await h.request("/v1/devices", authed(SERVICE_TOKEN))).status).toBe(401);

    expect((await h.request(`/v1/internal/devices/${account.deviceId}`, authed(account.token))).status).toBe(401);
    expect((await h.request(`/v1/internal/devices/${account.deviceId}`, authed(GATEWAY_TOKEN))).status).toBe(401);
    expect((await h.request(`/v1/internal/devices/${account.deviceId}`, authed(SERVICE_TOKEN))).status).toBe(200);

    expect((await h.request("/v1/egress/revocations", authed(account.token))).status).toBe(401);
    expect((await h.request("/v1/egress/revocations", authed(SERVICE_TOKEN))).status).toBe(401);
    expect((await h.request("/v1/egress/revocations", authed(GATEWAY_TOKEN))).status).toBe(200);
    expect((await h.request("/v1/egress/limits?userId=" + account.userId, authed(GATEWAY_TOKEN))).status).toBe(200);
    expect((await h.request("/v1/usage/egress", jsonInit("POST", { userId: account.userId, periodStart: 1, proxiedBytes: 1 }, account.token))).status).toBe(401);
  });

  it("closes service and gateway families when their secrets are unset", async () => {
    const closed = await makeHarness({ env: { CLOUD_BROWSER_SERVICE_TOKEN: undefined, EGRESS_GATEWAY_TOKEN: undefined } });
    const res = await closed.request("/v1/internal/runs/claim", jsonInit("POST", { workerId: "w" }, SERVICE_TOKEN));
    expect(res.status).toBe(503);
    expect((await closed.request("/v1/egress/revocations", authed(GATEWAY_TOKEN))).status).toBe(503);
  });

  it("answers healthz without auth at / and /v1", async () => {
    expect(await json(await h.request("/healthz"))).toEqual({ ok: true });
    expect(await json(await h.request("/v1/healthz"))).toEqual({ ok: true });
  });
});
