/**
 * CORS for the web app (browser devices call control cross-origin with a
 * device token in `Authorization`). The allowlist is exact origins from
 * `CONTROL_ALLOWED_ORIGINS`; there is no wildcard and no credentials mode,
 * because control has no cookie or session surface.
 */

import { describe, expect, it } from "vitest";
import { DEV_ALLOWED_ORIGINS, parseAllowedOrigins } from "../src/app.js";
import { authed, desktopAccount, json, makeHarness, type Harness } from "./helpers.js";

const APP = "https://app.pistachio.test";
const OTHER = "https://evil.example";

function preflight(origin: string, method = "GET", headers = "authorization,content-type"): RequestInit {
  return {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": headers,
    },
  };
}

async function allowingApp(): Promise<Harness> {
  return makeHarness({ env: { CONTROL_ALLOWED_ORIGINS: ` ${APP}/ , https://studio.pistachio.test ` } });
}

describe("parseAllowedOrigins", () => {
  it("normalises to exact origins and drops wildcards and junk", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins("  ,  ")).toEqual([]);
    expect(parseAllowedOrigins("*")).toEqual([]);
    expect(parseAllowedOrigins("not a url")).toEqual([]);
    expect(parseAllowedOrigins("https://a.test/, https://a.test, HTTPS://A.TEST")).toEqual(["https://a.test"]);
    expect(parseAllowedOrigins("https://a.test/some/path")).toEqual(["https://a.test"]);
    expect(parseAllowedOrigins("http://localhost:5173, https://b.test:8443")).toEqual([
      "http://localhost:5173",
      "https://b.test:8443",
    ]);
  });
});

describe("preflight", () => {
  it("answers an allowed origin with the headers the web app needs, without credentials", async () => {
    const h = await allowingApp();
    const res = await h.request("/v1/devices", preflight(APP));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    const methods = (res.headers.get("access-control-allow-methods") ?? "").split(",").map((m) => m.trim());
    expect(methods).toEqual(expect.arrayContaining(["GET", "POST", "PUT", "PATCH", "DELETE"]));
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const header of ["authorization", "content-type", "idempotency-key"]) {
      expect(allowed, header).toContain(header);
    }
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("gives an unlisted origin no allow-origin header", async () => {
    const h = await allowingApp();
    const res = await h.request("/v1/devices", preflight(OTHER));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("allows both web apps under the default a dev boot uses (§15)", async () => {
    // `www` on 3000 and the browser app on 3001 are two origins, and BOTH
    // call control with a device token. A default that listed only one would
    // leave a developer's browser app unable to sign in at all.
    const origins = parseAllowedOrigins(DEV_ALLOWED_ORIGINS);
    expect(origins).toEqual(["http://localhost:3000", "http://localhost:3001"]);
    const h = await makeHarness({ env: { CONTROL_ALLOWED_ORIGINS: DEV_ALLOWED_ORIGINS } });
    for (const origin of origins) {
      const res = await h.request("/v1/devices", preflight(origin));
      expect(res.status, origin).toBe(204);
      expect(res.headers.get("access-control-allow-origin"), origin).toBe(origin);
    }
  });

  it("is not installed at all when CONTROL_ALLOWED_ORIGINS is unset", async () => {
    const h = await makeHarness();
    const res = await h.request("/v1/devices", preflight(APP));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
  });
});

describe("actual requests", () => {
  it("carries the allow-origin header on a real authenticated response and never a wildcard", async () => {
    const h = await allowingApp();
    const account = await desktopAccount(h);
    const res = await h.request("/v1/me", { ...authed(account.token), headers: { authorization: `Bearer ${account.token}`, origin: APP } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect((await json<{ userId: string }>(res)).userId).toBe(account.userId);

    const stranger = await h.request("/v1/me", { headers: { authorization: `Bearer ${account.token}`, origin: OTHER } });
    expect(stranger.status).toBe(200);
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
  });
});
