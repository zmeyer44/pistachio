/**
 * Outbound email for the auth flows (password-reset OTP codes), §7.7.
 *
 *   MAILER=log     prints `[mailer] otp to=<email> code=<otp>` (dev only)
 *   MAILER=resend  POSTs to https://api.resend.com/emails with
 *                  RESEND_API_KEY / EMAIL_FROM (no `resend` dependency)
 *   unset          no transport: the reset routes answer 503; server.ts
 *                  refuses to boot without one
 */

export type AuthOtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

export interface AuthOtpArgs {
  email: string;
  otp: string;
  type: AuthOtpType;
}

export interface MailerOptions {
  /** null = no transport configured. */
  sendAuthOtp: ((args: AuthOtpArgs) => Promise<void>) | null;
}

/** Default for unit tests and embedded use: reset flows report unavailable. */
export const MAILER_DISABLED: MailerOptions = { sendAuthOtp: null };

export function logMailer(log: (line: string) => void = console.log): MailerOptions {
  return {
    sendAuthOtp: async ({ email, otp }) => {
      log(`[mailer] otp to=${email} code=${otp}`);
    },
  };
}

export function resendMailer(options: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
}): MailerOptions {
  const doFetch = options.fetch ?? fetch;
  return {
    sendAuthOtp: async ({ email, otp, type }) => {
      const subject =
        type === "forget-password" ? "Your Pistachio password reset code" : "Your Pistachio code";
      const res = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: [email],
          subject,
          text: `Your code is ${otp}. It expires in 10 minutes.`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`resend responded ${res.status}`);
    },
  };
}

export class MailerConfigError extends Error {}

/**
 * Resolve `MAILER`. Returns null when unset (the caller decides whether that
 * is fatal); throws when the named transport is misconfigured.
 */
export function mailerFromEnv(env: Record<string, string | undefined>): MailerOptions | null {
  const mode = env["MAILER"];
  if (mode === undefined || mode === "") return null;
  if (mode === "log") return logMailer();
  if (mode === "resend") {
    const apiKey = env["RESEND_API_KEY"];
    const from = env["EMAIL_FROM"];
    if (!apiKey || !from) {
      throw new MailerConfigError("MAILER=resend needs RESEND_API_KEY and EMAIL_FROM");
    }
    return resendMailer({ apiKey, from });
  }
  throw new MailerConfigError(`unknown MAILER "${mode}" (expected log or resend)`);
}
