/**
 * Human identity provider — BetterAuth wired to the control-plane database
 * (D21: server-side API only; no HTTP handler is mounted).
 *
 * BetterAuth owns only the HUMAN credential (email + password). A successful
 * password proof is exchanged in app.ts for the same short-lived EdDSA
 * bootstrap token the device plane understands; the device-token plane
 * (@pistachio/sync-protocol token.ts) stays authoritative for every other
 * request, including the session hub.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { randomUUID } from "node:crypto";
import type { Db } from "./db/client.js";
import type { MailerOptions } from "./mailer.js";
import { authAccounts, authSessions, authVerifications, users } from "./db/schema.js";

/** Matches the zod bounds in app.ts's signup/login schemas. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

/**
 * The `issuer` BetterAuth writes on an email+password credential row
 * (`createLocalAccountIssuer("credential")` in @better-auth/core, which is
 * not a dependency here). `POST /account/upgrade` writes that row itself, in
 * the transaction that gives the anonymous user its email;
 * test/anonymous-accounts.test.ts holds this equal to what `signUpEmail` writes.
 */
export const CREDENTIAL_ISSUER = "local:credential";

/** OTP codes are short-lived and guessing is bounded (3 attempts). */
export const PASSWORD_RESET_OTP_TTL_SECONDS = 10 * 60;

export type Idp = ReturnType<typeof createIdp>;

export function createIdp(db: Db, mailer: MailerOptions, secret?: string) {
  return betterAuth({
    // Only meaningful once an HTTP surface is mounted (redirect flows).
    baseURL: "http://localhost:8787",
    secret: secret ?? randomUUID(),
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    // `users` doubles as the BetterAuth user model with no field mapping;
    // the auth_* tables are BetterAuth's own (db/schema.ts).
    user: { modelName: "users" },
    session: { modelName: "authSessions" },
    account: { modelName: "authAccounts" },
    verification: { modelName: "authVerifications" },
    // Every id column in this database is uuid — BetterAuth's default text
    // ids would not insert.
    advanced: { database: { generateId: () => randomUUID() } },
    // Forgot-password rides 6-digit emailed OTP codes — a desktop app has no
    // page for a reset LINK to land on, so the code IS the ceremony.
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: PASSWORD_RESET_OTP_TTL_SECONDS,
        allowedAttempts: 3,
        async sendVerificationOTP({ email, otp, type }) {
          const send = mailer.sendAuthOtp;
          if (!send) throw new Error("no email transport configured (MAILER)");
          await send({ email, otp, type });
        },
      }),
    ],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { users, authSessions, authAccounts, authVerifications },
    }),
  });
}
