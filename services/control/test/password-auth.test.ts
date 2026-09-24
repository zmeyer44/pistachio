/**
 * Email+password accounts (src/idp.ts): signup, login → bootstrap token,
 * password change, and OTP reset purging `password` wrappers.
 */

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { toBase64 } from "@pistachio/sync-protocol";
import * as schema from "../src/db/schema.js";
import { logMailer } from "../src/mailer.js";
import {
  PASSWORD,
  authed,
  desktopAccount,
  enrollDesktop,
  json,
  jsonInit,
  makeHarness,
  nextEmail,
  signup,
  type Harness,
} from "./helpers.js";

let h: Harness;
const otpLog: string[] = [];
let mailed: Harness;

beforeAll(async () => {
  h = await makeHarness();
  mailed = await makeHarness({ mailer: logMailer((line) => otpLog.push(line)) });
});

async function passwordLogin(harness: Harness, email: string, password: string): Promise<Response> {
  return harness.request("/v1/auth/password-login", jsonInit("POST", { email, password }));
}

describe("POST /v1/accounts", () => {
  it("creates the user, a hashed credential, the work and __workspace__ spaces, and a bootstrap token", async () => {
    const email = nextEmail("pw");
    const out = await signup(h, email);
    expect(out.bootstrapToken.split(".")).toHaveLength(3);
    const [user] = await h.db.select().from(schema.users).where(eq(schema.users.id, out.userId));
    expect(user?.email).toBe(email);
    const [account] = await h.db.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, out.userId));
    expect(account?.providerId).toBe("credential");
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain(PASSWORD);
    const rows = await h.db.select().from(schema.spaces).where(eq(schema.spaces.userId, out.userId));
    expect(rows.map((s) => [s.id, s.name]).sort()).toEqual([
      ["__workspace__", "Workspace"],
      ["work", "Operations"],
    ]);
    const listed = await json<{ spaces: Array<{ id: string }> }>(await h.request("/v1/spaces", authed(out.bootstrapToken)));
    expect(listed.spaces.map((s) => s.id)).toEqual(["work"]);
  });

  it("409s a duplicate email case-insensitively and 400s a weak password or bad email", async () => {
    const email = nextEmail("dup");
    await signup(h, email);
    const dup = await h.request("/v1/accounts", jsonInit("POST", { email: email.toUpperCase(), password: PASSWORD }));
    expect(dup.status).toBe(409);
    expect((await json(dup))["error"]).toBe("email_taken");
    expect((await h.request("/v1/accounts", jsonInit("POST", { email: nextEmail(), password: "short" }))).status).toBe(400);
    expect((await h.request("/v1/accounts", jsonInit("POST", { email: "nope", password: PASSWORD }))).status).toBe(400);
    expect((await h.request("/v1/accounts", jsonInit("POST", { email: nextEmail() }))).status).toBe(400);
  });
});

describe("POST /v1/auth/password-login", () => {
  it("mints a bootstrap token that can enroll a device", async () => {
    const { email, userId } = await signup(h);
    const res = await passwordLogin(h, email, PASSWORD);
    expect(res.status).toBe(200);
    const out = await json<{ userId: string; bootstrapToken: string; exp: number }>(res);
    expect(out.userId).toBe(userId);
    expect(typeof out.exp).toBe("number");
    await enrollDesktop(h, out.bootstrapToken);
    const sessions = await h.db.select().from(schema.authSessions).where(eq(schema.authSessions.userId, userId));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const audits = await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, userId));
    expect(audits.some((a) => a.kind === "auth.password_login")).toBe(true);
  });

  it("403s a wrong password and an unknown email identically", async () => {
    const { email } = await signup(h);
    const wrong = await passwordLogin(h, email, "not-the-password");
    expect(wrong.status).toBe(403);
    expect((await json(wrong))["error"]).toBe("invalid_credentials");
    const unknown = await passwordLogin(h, "nobody@example.com", PASSWORD);
    expect(unknown.status).toBe(403);
    expect((await json(unknown))["error"]).toBe("invalid_credentials");
  });

  it("rate-limits repeated attempts per email", async () => {
    const { email } = await signup(h);
    for (let i = 0; i < 10; i += 1) expect((await passwordLogin(h, email, "wrong")).status).toBe(403);
    const blocked = await passwordLogin(h, email, PASSWORD);
    expect(blocked.status).toBe(429);
  });
});

describe("POST /v1/auth/password", () => {
  it("changes the password with proof of the current one and never touches wrappers", async () => {
    const account = await desktopAccount(h);
    await h.request(
      "/v1/spaces/work/wrappers",
      jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", salt: toBase64(new Uint8Array(16)), wrapped: toBase64(new Uint8Array(48)) }] }, account.token),
    );
    const wrong = await h.request("/v1/auth/password", jsonInit("POST", { currentPassword: "nope", newPassword: "a-brand-new-password" }, account.token));
    expect(wrong.status).toBe(403);
    expect((await json(wrong))["error"]).toBe("invalid_credentials");
    const changed = await h.request("/v1/auth/password", jsonInit("POST", { currentPassword: PASSWORD, newPassword: "a-brand-new-password" }, account.token));
    expect(changed.status).toBe(200);
    expect(await json(changed)).toEqual({ ok: true });
    expect((await passwordLogin(h, account.email, PASSWORD)).status).toBe(403);
    expect((await passwordLogin(h, account.email, "a-brand-new-password")).status).toBe(200);
    const wrappers = await json<{ wrappers: unknown[] }>(await h.request("/v1/spaces/work/wrappers", authed(account.token)));
    expect(wrappers.wrappers).toHaveLength(1);
    // Bootstrap tokens cannot change the password (device required).
    const boot = await h.request("/v1/auth/password", jsonInit("POST", { currentPassword: "a-brand-new-password", newPassword: "another-new-password" }, account.bootstrapToken));
    expect(boot.status).toBe(403);
    expect((await json(boot))["error"]).toBe("device_required");
  });
});

describe("password reset (email OTP)", () => {
  it("is closed when no mailer is configured", async () => {
    const res = await h.request("/v1/auth/password-reset/request", jsonInit("POST", { email: nextEmail() }));
    expect(res.status).toBe(503);
    expect((await json(res))["error"]).toBe("password_reset_unavailable");
  });

  it("emails a code, resets the password, and purges every password wrapper", async () => {
    const account = await desktopAccount(mailed);
    for (const spaceId of ["work", "__workspace__"]) {
      const put = await mailed.request(
        `/v1/spaces/${spaceId}/wrappers`,
        jsonInit("PUT", { wrappers: [
          { kind: "password", credentialId: "password", salt: toBase64(new Uint8Array(16)), wrapped: toBase64(new Uint8Array(48)) },
          { kind: "recovery-code", credentialId: "recovery", salt: toBase64(new Uint8Array(16)), wrapped: toBase64(new Uint8Array(48)) },
        ] }, account.token),
      );
      expect(put.status).toBe(200);
    }
    const requested = await mailed.request("/v1/auth/password-reset/request", jsonInit("POST", { email: account.email }));
    expect(requested.status).toBe(202);
    const line = otpLog.find((l) => l.includes(`to=${account.email}`));
    expect(line).toBeDefined();
    const code = /code=(\d{6})/.exec(line ?? "")?.[1];
    expect(code).toBeDefined();
    const wrongCode = await mailed.request("/v1/auth/password-reset/confirm", jsonInit("POST", { email: account.email, code: "000000", password: "post-reset-password" }));
    expect(wrongCode.status).toBe(403);
    const confirmed = await mailed.request("/v1/auth/password-reset/confirm", jsonInit("POST", { email: account.email, code, password: "post-reset-password" }));
    expect(confirmed.status).toBe(204);
    expect((await passwordLogin(mailed, account.email, PASSWORD)).status).toBe(403);
    expect((await passwordLogin(mailed, account.email, "post-reset-password")).status).toBe(200);
    const remaining = await mailed.db.select().from(schema.keyWrappers).where(eq(schema.keyWrappers.userId, account.userId));
    expect(remaining.map((w) => w.kind).sort()).toEqual(["recovery-code", "recovery-code"]);
  });

  it("answers 202 for an unknown email without sending mail", async () => {
    const before = otpLog.length;
    const res = await mailed.request("/v1/auth/password-reset/request", jsonInit("POST", { email: "ghost@example.com" }));
    expect(res.status).toBe(202);
    expect(otpLog.length).toBe(before);
  });
});
