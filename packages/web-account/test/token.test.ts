import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceTokenSession, tokenExpSeconds, TOKEN_REFRESH_LEEWAY_SECONDS } from "../src/token";

/**
 * The device token this browser holds, and when it is replaced
 * (docs/cloud-sync-design.md §17; the package is shared by both web apps, so
 * this is the one place the rule is written down).
 *
 * Control mints ten-minute tokens. The session's whole job is that a tab left
 * open never sees one expire: it re-mints inside the leeway window, it answers
 * a 401 once, and it never starts two re-mints for the same token.
 */

/** A compact JWT with nothing but the claim the session reads. */
function jwt(exp: number | null, marker = "t"): string {
  const claims = exp === null ? { marker } : { exp, marker };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header.${body}.signature`;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tokenExpSeconds", () => {
  it("reads exp from the payload without verifying anything", () => {
    const exp = nowSeconds() + 600;
    expect(tokenExpSeconds(jwt(exp))).toBe(exp);
  });

  it("answers null for a token it cannot read, rather than a wrong number", () => {
    expect(tokenExpSeconds("not-a-jwt")).toBeNull();
    expect(tokenExpSeconds("header.%%%.signature")).toBeNull();
    // A token with no `exp` never becomes stale on its own; the session leaves
    // it alone and lets a 401 speak for it.
    expect(tokenExpSeconds(jwt(null))).toBeNull();
  });
});

describe("DeviceTokenSession", () => {
  it("hands back the held token while it is nowhere near expiry", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const token = jwt(nowSeconds() + 600);
    const session = new DeviceTokenSession({ token, proof: () => Promise.reject(new Error("not asked")) });
    try {
      await expect(session.get()).resolves.toBe(token);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it("re-mints inside the leeway window, before control would refuse anything", async () => {
    const fresh = jwt(nowSeconds() + 600, "fresh");
    const fetched = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ token: fresh, exp: nowSeconds() + 600 }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetched);
    const adopted: string[] = [];
    // Still valid, but inside the last minute of its life.
    const token = jwt(nowSeconds() + TOKEN_REFRESH_LEEWAY_SECONDS - 5);
    const session = new DeviceTokenSession({
      token,
      proof: () => Promise.reject(new Error("the refresh answered")),
      onToken: (value) => adopted.push(value),
    });
    try {
      await expect(session.get()).resolves.toBe(fresh);
      expect(session.current()).toBe(fresh);
      expect(adopted).toEqual([fresh]);
      expect(fetched).toHaveBeenCalledTimes(1);
      expect(String(fetched.mock.calls.at(0)?.at(0))).toContain("/v1/auth/token/refresh");
    } finally {
      session.close();
    }
  });

  it("proves possession of the device key when control refuses the refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "token_expired" }), { status: 401 })),
      ),
    );
    const minted = jwt(nowSeconds() + 600, "minted");
    const proof = vi.fn(() => Promise.resolve(minted));
    const stale = jwt(nowSeconds() - 10);
    const session = new DeviceTokenSession({ token: stale, proof });
    try {
      await expect(session.renew(stale)).resolves.toBe(minted);
      expect(proof).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it("keeps the token when the refresh fails for a reason that is not a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    const proof = vi.fn(() => Promise.reject(new Error("the network, not the key")));
    const token = jwt(nowSeconds() + 30);
    const session = new DeviceTokenSession({ token, proof });
    try {
      await expect(session.renew(token)).resolves.toBeNull();
      expect(session.current()).toBe(token);
      // `get()` falls back to what it holds rather than answering null: the
      // caller's own request is what should fail, not the session.
      await expect(session.get()).resolves.toBe(token);
    } finally {
      session.close();
    }
  });

  it("shares one attempt for a burst of refusals, and answers a stale one at once", async () => {
    const fresh = jwt(nowSeconds() + 600, "fresh");
    const fetched = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(JSON.stringify({ token: fresh, exp: nowSeconds() + 600 }), { status: 200 })),
            5,
          );
        }),
    );
    vi.stubGlobal("fetch", fetched);
    const token = jwt(nowSeconds() + 30);
    const session = new DeviceTokenSession({ token, proof: () => Promise.reject(new Error("not asked")) });
    try {
      const [a, b] = await Promise.all([session.renew(token), session.renew(token)]);
      expect(a).toBe(fresh);
      expect(b).toBe(fresh);
      expect(fetched).toHaveBeenCalledTimes(1);
      // A call that raced the re-mint sends the token it was holding; the
      // session hands back the current one rather than minting a second.
      await expect(session.renew(token)).resolves.toBe(fresh);
      expect(fetched).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it("stops answering once the browser signs out", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("not asked"))));
    const token = jwt(nowSeconds() + 30);
    const session = new DeviceTokenSession({ token, proof: () => Promise.reject(new Error("not asked")) });
    session.close();
    await expect(session.renew(token)).resolves.toBeNull();
  });
});
