/**
 * ControlClient (docs/cloud-sync-design.md §7.2, §10.1): a rejected token
 * is not terminal — one device-login proof, one retry — refreshes are
 * single-flight and persisted through onTokenChanged, and every call has a
 * timeout. The token helpers' schedule is pinned at exp − 60 s.
 */

import { generateTokenKeypair, importTokenSigningKey, signDeviceToken } from "@pistachio/sync-protocol";
import { describe, expect, it } from "vitest";
import {
  isBootstrapToken,
  refreshDelayMs,
  shouldRefreshToken,
  TOKEN_REFRESH_LEEWAY_SECONDS,
  tokenClaims,
  tokenExpSeconds,
} from "../src/main/account/auth-token";
import {
  ControlClient,
  ControlError,
  DEFAULT_CONTROL_URL,
  DEFAULT_WEB_URL,
  PROD_CONTROL_URL,
  PROD_WEB_URL,
  resolveControlUrl,
  resolveWebUrl,
} from "../src/main/account/control-client";

function jwtWith(payload: Record<string, unknown>): string {
  const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url(payload)}.c2ln`;
}

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unauthorized = (): Response => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

describe("token helpers", () => {
  it("reads exp and the bootstrap shape from a compact JWT", () => {
    expect(tokenExpSeconds(jwtWith({ sub: "u", exp: 1_700_000_600 }))).toBe(1_700_000_600);
    expect(tokenExpSeconds(jwtWith({ sub: "u" }))).toBeNull();
    expect(tokenExpSeconds("a.!!!!.c")).toBeNull();
    expect(tokenExpSeconds("a.b")).toBeNull();
    expect(tokenClaims(jwtWith({ sub: "u", did: "d" }))).toEqual({ sub: "u", did: "d" });
    expect(isBootstrapToken(jwtWith({ sub: "u", did: "u" }))).toBe(true);
    expect(isBootstrapToken(jwtWith({ sub: "u", did: "d" }))).toBe(false);
    expect(isBootstrapToken("opaque")).toBe(false);
  });

  it("reads the claims of a token control actually signed", async () => {
    // The unverified reader and the signer now share one base64url decoder;
    // a padding disagreement between them would show up right here.
    const keypair = await generateTokenKeypair();
    const claims = {
      sub: "11111111-1111-4111-8111-111111111111",
      did: "22222222-2222-4222-8222-222222222222",
      iat: 1_700_000_000,
      exp: 1_700_000_600,
      jti: "33333333-3333-4333-8333-333333333333",
    };
    const token = await signDeviceToken(await importTokenSigningKey(keypair.privateKeyPkcs8), claims);
    expect(tokenClaims(token)).toEqual(claims);
    expect(tokenExpSeconds(token)).toBe(claims.exp);
    expect(isBootstrapToken(token)).toBe(false);
  });

  it("decodes payloads whose base64url needs padding and the url alphabet", () => {
    // Lengths 1..4 cover every padding case; the emoji forces '-'/'_' bytes.
    for (const pad of ["", "a", "ab", "abc"]) {
      const claims = { sub: `u${pad}`, did: "d\u00ff\u{1f600}" };
      const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
      expect(encoded).not.toMatch(/[=+/]/);
      expect(tokenClaims(`aGVhZGVy.${encoded}.c2ln`)).toEqual(claims);
    }
  });

  it("refreshes exactly at exp − leeway", () => {
    const exp = 10_000;
    expect(shouldRefreshToken(exp, exp - TOKEN_REFRESH_LEEWAY_SECONDS - 1)).toBe(false);
    expect(shouldRefreshToken(exp, exp - TOKEN_REFRESH_LEEWAY_SECONDS)).toBe(true);
    expect(shouldRefreshToken(exp, exp + 1)).toBe(true);
    expect(refreshDelayMs(10_000, 1_000_000)).toBe((10_000 - TOKEN_REFRESH_LEEWAY_SECONDS) * 1000 - 1_000_000);
    expect(refreshDelayMs(100, 200_000_000)).toBe(0);
  });
});

describe("resolveControlUrl", () => {
  it("prefers PISTACHIO_CONTROL_URL, then the packaged host, then the dev default", () => {
    expect(resolveControlUrl({ PISTACHIO_CONTROL_URL: "http://control.test/" }, true)).toBe("http://control.test");
    expect(resolveControlUrl({}, true)).toBe(PROD_CONTROL_URL);
    expect(resolveControlUrl({}, false)).toBe(DEFAULT_CONTROL_URL);
    expect(resolveControlUrl({ PISTACHIO_CONTROL_URL: "  " }, false)).toBe(DEFAULT_CONTROL_URL);
  });
});

describe("resolveWebUrl", () => {
  it("prefers PISTACHIO_WEB_URL, then the packaged host, then the dev app", () => {
    expect(resolveWebUrl({ PISTACHIO_WEB_URL: "https://app.example/" }, true)).toBe("https://app.example");
    expect(resolveWebUrl({}, true)).toBe(PROD_WEB_URL);
    expect(resolveWebUrl({}, false)).toBe(DEFAULT_WEB_URL);
  });
});

describe("ControlClient re-auth on a rejected token", () => {
  it("proves the device key once and retries the request", async () => {
    const calls: string[] = [];
    let accepted = false;
    const client = new ControlClient("http://control.test", {
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${String(init?.method ?? "GET")} ${path}`);
        if (path === "/v1/devices") return accepted ? ok({ devices: [{ id: "d1" }] }) : unauthorized();
        throw new Error(`unexpected ${path}`);
      },
    });
    client.setToken("stale");
    client.setReauth(async () => {
      accepted = true;
      return "fresh";
    });
    expect(await client.listDevices()).toEqual([{ id: "d1" }]);
    expect(calls).toEqual(["GET /v1/devices", "GET /v1/devices"]);
    expect(client.token()).toBe("fresh");
  });

  it("shares one device-login across concurrent 401s", async () => {
    let accepted = false;
    let proofs = 0;
    const client = new ControlClient("http://control.test", {
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/devices") return accepted ? ok({ devices: [] }) : unauthorized();
        throw new Error(`unexpected ${path}`);
      },
    });
    client.setToken("stale");
    client.setReauth(async () => {
      proofs += 1;
      await Promise.resolve();
      accepted = true;
      return "fresh";
    });
    await Promise.all([client.listDevices(), client.listDevices(), client.listDevices()]);
    expect(proofs).toBe(1);
  });

  it("only reports unauthorized when the proof itself fails — a revoked device", async () => {
    let unauthorizedSeen = 0;
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () => unauthorized(),
      onUnauthorized: () => {
        unauthorizedSeen += 1;
      },
    });
    client.setToken("stale");
    client.setReauth(async () => null);
    await expect(client.listDevices()).rejects.toThrow(/unauthorized/);
    expect(unauthorizedSeen).toBe(1);
    expect(client.token()).toBeNull();
  });

  it("retries at most once, so a server that always 401s cannot loop", async () => {
    let requests = 0;
    let proofs = 0;
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () => {
        requests += 1;
        return unauthorized();
      },
    });
    client.setToken("stale");
    client.setReauth(async () => {
      proofs += 1;
      return "fresh-but-still-rejected";
    });
    await expect(client.listDevices()).rejects.toThrow(/unauthorized/);
    expect(requests).toBe(2);
    expect(proofs).toBe(1);
  });

  it("keeps the token when the proof could not be made at all", async () => {
    // The proof REJECTS (the plane was unreachable, or answered 5xx/429):
    // that is not control refusing this key, so the enrollment stands and
    // the request fails as the transport error it is.
    let unauthorizedSeen = 0;
    let proofs = 0;
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () => unauthorized(),
      onUnauthorized: () => {
        unauthorizedSeen += 1;
      },
    });
    client.setToken("held");
    client.setReauth(async () => {
      proofs += 1;
      throw new Error("control plane unreachable at http://control.test (timed out)");
    });
    await expect(client.listDevices()).rejects.toThrow(/unreachable/);
    expect(proofs).toBe(1);
    expect(client.token()).toBe("held");
    expect(unauthorizedSeen).toBe(0);
    client.dispose();
  });

  it("keeps the token when a refresh's proof hits a 503, and does not report revocation", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3_600;
    const token = jwtWith({ sub: "u", did: "d", exp, jti: "k" });
    let unauthorizedSeen = 0;
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () => unauthorized(),
      onUnauthorized: () => {
        unauthorizedSeen += 1;
      },
    });
    client.setToken(token);
    client.setReauth(async () => {
      throw new ControlError(503, "unavailable", "POST", "/v1/auth/device-challenge");
    });
    await client.refresh();
    expect(client.token()).toBe(token);
    expect(unauthorizedSeen).toBe(0);
    client.dispose();
  });

  it("carries control's reason for a 401 on the proof's own routes, and leaves the token alone", async () => {
    // `deviceChallenge`/`deviceLogin` never re-authenticate; a 401 from one
    // of them is the proof failing, and must not tear down the token the
    // proof exists to renew.
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "unauthorized", reason: "challenge_expired" }), { status: 401 }),
      onUnauthorized: () => {
        throw new Error("the proof's own routes must never report revocation");
      },
    });
    client.setToken("held");
    const failure = await client
      .deviceLogin({ deviceId: "d", challenge: "c", signature: "s" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ControlError);
    expect((failure as ControlError).code).toBe("challenge_expired");
    expect(client.token()).toBe("held");
    client.dispose();
  });

  it("never invalidates a token that replaced the one a stale 401 judged", async () => {
    let unauthorizedSeen = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () => {
        await gate;
        return unauthorized();
      },
      onUnauthorized: () => {
        unauthorizedSeen += 1;
      },
    });
    client.setToken("old");
    const pending = client.listDevices();
    client.setToken("new");
    release();
    await expect(pending).rejects.toThrow(/unauthorized/);
    expect(unauthorizedSeen).toBe(0);
    expect(client.token()).toBe("new");
  });
});

describe("ControlClient refresh", () => {
  it("publishes a silently refreshed token to its owner and shares one refresh", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3_600;
    const stale = jwtWith({ sub: "u", did: "d", exp, jti: "old" });
    const fresh = jwtWith({ sub: "u", did: "d", exp, jti: "new" });
    const changed: Array<string | null> = [];
    let refreshes = 0;
    const client = new ControlClient("http://control.test", {
      fetchImpl: async (input) => {
        expect(new URL(String(input)).pathname).toBe("/v1/auth/token/refresh");
        refreshes += 1;
        await Promise.resolve();
        return ok({ token: fresh, exp });
      },
      onTokenChanged: (token) => changed.push(token),
    });
    client.setToken(stale);
    await Promise.all([client.refresh(), client.refresh()]);
    expect(refreshes).toBe(1);
    expect(await client.getToken()).toBe(fresh);
    expect(changed).toEqual([stale, fresh]);
    client.dispose();
  });

  it("refreshes before answering getToken once inside the leeway window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dueSoon = jwtWith({ sub: "u", did: "d", exp: now + 30, jti: "old" });
    const fresh = jwtWith({ sub: "u", did: "d", exp: now + 600, jti: "new" });
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () => ok({ token: fresh, exp: now + 600 }),
    });
    client.setToken(dueSoon);
    expect(await client.getToken()).toBe(fresh);
    client.dispose();
  });

  it("keeps the token through a network error", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3_600;
    const token = jwtWith({ sub: "u", did: "d", exp, jti: "k" });
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    client.setToken(token);
    await client.refresh();
    expect(client.token()).toBe(token);
    client.dispose();
  });
});

describe("ControlClient requests", () => {
  it("times out and reports the plane unreachable", async () => {
    const client = new ControlClient("http://control.test", {
      timeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await expect(client.me()).rejects.toThrow(/unreachable/);
  });

  it("surfaces control's error code on a non-2xx answer", async () => {
    const client = new ControlClient("http://control.test", {
      fetchImpl: async () => ok({ error: "device_id_taken" }, 409),
    });
    client.setToken("t");
    const failure = await client
      .enrollDevice({
        deviceId: "d",
        name: "n",
        platform: "macos",
        devicePublicKey: "",
        agreementPublicKey: "",
        challenge: "c",
        signature: "s",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ControlError);
    expect((failure as ControlError).status).toBe(409);
    expect((failure as ControlError).code).toBe("device_id_taken");
  });

  it("sends the bearer and the JSON body the routes expect", async () => {
    const seen: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = [];
    const client = new ControlClient("http://control.test/", {
      fetchImpl: async (input, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.push({
          method: init?.method ?? "GET",
          path: new URL(String(input)).pathname + new URL(String(input)).search,
          auth: headers["authorization"],
          body: init?.body === null || init?.body === undefined ? null : JSON.parse(String(init.body)),
        });
        const path = new URL(String(input)).pathname;
        if (path === "/v1/cloud/disable") return new Response(null, { status: 204 });
        if (path === "/v1/channels" && init?.method === "GET")
          return ok({ channels: [{ id: "l1", name: "n", spaceId: "work", outboundUrl: null, createdAt: "t", revokedAt: null }] });
        return ok({ wrappers: [], runId: "r", runs: [], device: { id: "d" } });
      },
    });
    client.setToken("tok");
    await client.putWrappers("work", [{ kind: "password", credentialId: "password", salt: "s", wrapped: "w" }]);
    await client.deleteWrapper("__workspace__", "device-x25519", "cloud-1");
    await client.setSyncPolicyOverride("example.com", "never");
    await client.createRun({ spaceId: "work", intent: "do", startUrl: "https://a.example" });
    await client.listRuns("work");
    await client.disableCloud("work");
    await client.completeOnboarding();
    expect(await client.listChannels()).toEqual([
      { linkId: "l1", name: "n", spaceId: "work", outboundUrl: null, createdAt: "t", revokedAt: null },
    ]);
    expect(client.runEventsUrl("r1", 7)).toBe("http://control.test/v1/runs/r1/events?since=7");
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /v1/spaces/work/wrappers",
      "DELETE /v1/spaces/__workspace__/wrappers/device-x25519/cloud-1",
      "PUT /v1/sync/policy/overrides/example.com",
      "POST /v1/runs",
      "GET /v1/runs?spaceId=work",
      "POST /v1/cloud/disable",
      "POST /v1/me/onboarding/complete",
      "GET /v1/channels",
    ]);
    expect(seen.every((call) => call.auth === "Bearer tok")).toBe(true);
    expect(seen[0]?.body).toEqual({ wrappers: [{ kind: "password", credentialId: "password", salt: "s", wrapped: "w" }] });
    expect(seen[3]?.body).toEqual({ spaceId: "work", intent: "do", startUrl: "https://a.example" });
  });
});


describe("native credential capture transport", () => {
  it("relays form metadata and only ciphertext, preserving expiry and duplicate errors across IPC", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    let submitted = false;
    const client = new ControlClient("http://control.test", {
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path, body });
        if (path.endsWith("/expired")) return ok({ error: "expired" }, 410);
        if (path.endsWith("/submit")) {
          if (submitted) return ok({ error: "already_submitted" }, 409);
          submitted = true;
          return ok({ ok: true });
        }
        return ok({ capture: { id: "capture-1", status: "pending", encryptionPublicKey: "public-key" } });
      },
    });
    expect(await client.getCredentialCapture("capture-1")).toMatchObject({
      ok: true, value: { id: "capture-1", encryptionPublicKey: "public-key" },
    });
    expect(await client.submitCredentialCapture("capture-1", "sealed-box")).toEqual({ ok: true, value: null });
    expect(requests).toEqual([
      { path: "/v1/credential-captures/capture-1", body: null },
      { path: "/v1/credential-captures/capture-1/submit", body: { sealedPayload: "sealed-box" } },
    ]);
    expect(await client.getCredentialCapture("expired")).toEqual({ ok: false, status: 410, code: "expired" });
    expect(await client.submitCredentialCapture("capture-1", "sealed-box")).toEqual({ ok: false, status: 409, code: "already_submitted" });
  });
});
