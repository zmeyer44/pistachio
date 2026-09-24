/**
 * Anonymous accounts (docs/anonymous-accounts.md): the policy, kept pure so
 * every rule is unit-testable.
 *
 * A Mac nobody has signed in on still gets an account — a `users` row with
 * no email and `is_anonymous` set, and this Mac enrolled as its one device —
 * so its model calls have an owner to meter and to bound. What that account
 * may do is an ALLOW-list (`anonymousAllowed`): the models, its own usage,
 * and the two routes that turn it into a real account. Everything that keeps
 * a person's data on this plane (sync, the vault, integrations, the cloud
 * browser, channels) needs a credential that can get the data back, which an
 * anonymous account does not have.
 *
 * Three bounds stand where a real account has only its own spend cap:
 *   - minting: a fixed window per client address, since a fresh account is
 *     a fresh allowance;
 *   - spend: a monthly USD allowance the account cannot raise;
 *   - pace: requests per minute, and a tighter one for the models in
 *     `AI_ANONYMOUS_SLOW_MODELS` (the expensive ones).
 */

import { PasswordAttemptLimiter } from "./abuse.js";

/** How many anonymous accounts one client address may mint per window. */
export const ANONYMOUS_SIGNUPS_PER_IP = 10;
export const ANONYMOUS_SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/** The monthly model allowance, in USD; `AI_ANONYMOUS_MONTHLY_USD` overrides it. */
export const ANONYMOUS_MONTHLY_USD_ENV = "AI_ANONYMOUS_MONTHLY_USD";
export const DEFAULT_ANONYMOUS_MONTHLY_USD = 5;

/** Model requests per minute, all kinds together; `AI_ANONYMOUS_RPM` overrides it. */
export const ANONYMOUS_RPM_ENV = "AI_ANONYMOUS_RPM";
export const DEFAULT_ANONYMOUS_RPM = 60;

/**
 * Comma-separated model ids (as the SDK names them in `ai-model-id`, e.g.
 * `anthropic/claude-opus-5`) that an anonymous account may call only
 * `AI_ANONYMOUS_SLOW_RPM` times a minute. Empty by default: nothing is slow.
 */
export const ANONYMOUS_SLOW_MODELS_ENV = "AI_ANONYMOUS_SLOW_MODELS";
export const ANONYMOUS_SLOW_RPM_ENV = "AI_ANONYMOUS_SLOW_RPM";
export const DEFAULT_ANONYMOUS_SLOW_RPM = 6;

export const ANONYMOUS_AI_WINDOW_MS = 60_000;

/**
 * An anonymous account whose device has not been seen for this long is
 * deleted by the hourly job: nobody can ever sign in to it, so once its Mac
 * stops calling there is no way back to it.
 */
export const ANONYMOUS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How long `account_links` remembers where a folded-in anonymous account
 * went. It only has to outlive a model answer that was streaming when the
 * link happened (the proxy cuts one at ten minutes); a day is generous.
 */
export const ACCOUNT_LINK_RETENTION_MS = 24 * 60 * 60 * 1000;

const AI_PATH_PREFIX = "/v1/ai/";

/** The whole surface an anonymous account's device may reach (§ "What it can do"). */
export function anonymousAllowed(method: string, path: string): boolean {
  if (path.startsWith(AI_PATH_PREFIX)) return true;
  if (method === "GET") return path === "/v1/me" || path === "/v1/ai-usage";
  if (method === "POST") return path === "/v1/me/onboarding/complete" || path === "/v1/account/upgrade";
  return false;
}

export interface AnonymousAiPolicy {
  monthlyUsd: number;
  requestsPerMinute: number;
  slowModels: ReadonlySet<string>;
  slowRequestsPerMinute: number;
}

function positive(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim() ?? "");
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read per request, like the service secrets, so an operator can retune without a restart. */
export function anonymousAiPolicy(env: Record<string, string | undefined>): AnonymousAiPolicy {
  return {
    monthlyUsd: positive(env[ANONYMOUS_MONTHLY_USD_ENV], DEFAULT_ANONYMOUS_MONTHLY_USD),
    requestsPerMinute: Math.floor(positive(env[ANONYMOUS_RPM_ENV], DEFAULT_ANONYMOUS_RPM)),
    slowModels: new Set(
      (env[ANONYMOUS_SLOW_MODELS_ENV] ?? "")
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id !== ""),
    ),
    slowRequestsPerMinute: Math.floor(positive(env[ANONYMOUS_SLOW_RPM_ENV], DEFAULT_ANONYMOUS_SLOW_RPM)),
  };
}

/**
 * A fixed window whose limit is read at each ask (the policy can change
 * under it) and whose spent windows are dropped, so the map holds only the
 * accounts that called in the last minute.
 */
export class AnonymousAiLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    private readonly windowMs = ANONYMOUS_AI_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Seconds until the window turns when refused; null when allowed. */
  take(key: string, limit: number): number | null {
    const now = this.now();
    if (now - this.lastSweep >= this.windowMs) {
      for (const [k, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(k);
      this.lastSweep = now;
    }
    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      if (limit <= 0) return Math.ceil(this.windowMs / 1000);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    if (entry.count >= limit) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.count += 1;
    return null;
  }

  size(): number {
    return this.hits.size;
  }
}

export function anonymousSignupLimiter(now?: () => number): PasswordAttemptLimiter {
  return new PasswordAttemptLimiter(ANONYMOUS_SIGNUPS_PER_IP, ANONYMOUS_SIGNUP_WINDOW_MS, now);
}

/** What any other route answers an anonymous account's device. */
export const ACCOUNT_REQUIRED = {
  error: "account_required",
  explanation: "This needs a Pistachio account. Create one under Settings → Account; what this Mac has done so far comes with it.",
} as const;

/**
 * The model refusals, shaped as the gateway shapes one so the desktop's SDK
 * turns each into an error whose message says what happened, and marked with
 * control's own reason (as `AI_BUDGET_EXCEEDED` is).
 */
export const ANONYMOUS_BUDGET_EXCEEDED = {
  error: {
    type: "forbidden",
    message:
      "This Mac has used the models that come without an account for this month. Create a free account under Settings → Account to keep going — everything here comes with it.",
  },
  reason: "anonymous_budget_exceeded",
} as const;

export const ANONYMOUS_RATE_LIMITED = {
  error: {
    type: "rate_limit_exceeded",
    message:
      "Too many model requests in a minute for a Mac without an account. Wait a moment, or create a free account under Settings → Account.",
  },
  reason: "anonymous_rate_limited",
} as const;
