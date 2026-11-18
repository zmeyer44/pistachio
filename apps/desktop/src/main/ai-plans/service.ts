/**
 * A person's ChatGPT plan, connected (docs/ai-plans.md): the sign-in, the
 * session kept alive, the state the shell is shown, and the model a turn is
 * handed while the chat is on the plan.
 *
 * **The state** is one of six (shell-contracts/ai-plans `AiPlanStatus`), and
 * each has one way out the person can take:
 *
 *   off ──connect──▶ connecting ──callback──▶ ready
 *   ready ──a usage limit──▶ limit        (resume, or switch to Pistachio's models)
 *   ready ──not available──▶ ineligible   (switch, or another account)
 *   ready ──session over──▶ signIn        (sign in again: same registration)
 *
 * **While the plan is chosen, a turn never runs on Pistachio's models
 * instead.** If the plan cannot serve it, the turn stops on a sentence that
 * says why and what to do (`turn()` answers `blocked`): OpenAI does not move
 * a request to another way of paying, and neither does Pistachio — the
 * switch is the person's, one press in Settings or beside the composer.
 *
 * **Nothing is known of what is left of a plan.** OpenAI gives an app no
 * such number on this route; the page for it is theirs (*Manage usage*).
 * What is kept here is Pistachio's own count of what it sent, and what the
 * last request said — a limit, a lapsed sign-in — the moment it says it.
 * A check at launch and every few hours finds a connection that ended in
 * ChatGPT's settings before a turn does: OpenAI does not tell an app when
 * it is disconnected.
 *
 * Tokens stay in main, sealed (./store.ts); what leaves is `snapshot()`.
 * No error from OpenAI is shown or logged as it came: a code picks one of
 * Pistachio's own sentences (their bodies can name the account).
 */

import type { LanguageModel } from "ai";
import {
  CHATGPT_USAGE_URL,
  type AiPlanRequest,
  type AiPlanResponse,
  type AiPlanStatus,
  type AiPlanTrouble,
  type AiPlansSnapshot,
} from "@pistachio/shell-contracts/ai-plans";
import { listenForCallback, type CallbackListener, type CallbackOutcome } from "./callback";
import { PLAN_PROVIDER_OPTIONS, pickPlanModel, planLanguageModel, planModelName, readPlanModels } from "./model";
import { PLAN_FAILURE_WORDS, PlanError, planFetch, type PlanUsage } from "./plan-request";
import {
  OPENAI_DISCOVERY,
  OPENAI_ENDPOINTS,
  SiwcError,
  authorizeUrl,
  discover,
  exchangeCode,
  fetchKeys,
  grantsPlanUse,
  newAttempt,
  readCallback,
  refreshTokens,
  revokeSession,
  verifyIdToken,
  type SiwcAttempt,
  type SiwcEndpoints,
  type SiwcReturning,
} from "./siwc";
import { tallyUsage, type AiPlanStore } from "./store";

/** A token is renewed this long before it lapses, so a request never starts on one about to. */
export const REFRESH_AHEAD_MS = 5 * 60_000;
/** A token this fresh is not renewed again because a request refused it: the refusal is about something else. */
const JUST_REFRESHED_MS = 60_000;
/** How long a sign-in page may be out before the wait is given up. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** How often a connection is looked at while the app runs. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 8_000;

/** What a turn is handed: the plan's model, or the reason the plan cannot serve it. */
export type PlanTurn =
  | { model: LanguageModel; name: string; source: "chatgpt"; providerOptions: typeof PLAN_PROVIDER_OPTIONS }
  | { blocked: PlanError };

/** What a turn stops on while plan requests are paused: the limit was said when it was hit; this is the turn after. */
export const PAUSED_FOR_LIMIT = `Requests on your ChatGPT plan are paused: its usage limit was reached. [Manage usage](${CHATGPT_USAGE_URL}) in ChatGPT, then choose Try again under Settings → AI plan — or switch to Pistachio's models there.`;
const NOT_GRANTED =
  "ChatGPT signed you in, but plan usage wasn't allowed, so Pistachio isn't using your plan. Continue with ChatGPT again and allow it, or keep using Pistachio's models.";
const NO_KEYCHAIN = "This Mac's keychain isn't available to Pistachio, so a ChatGPT sign-in can't be kept safely here.";

export interface AiPlanServiceOptions {
  store: AiPlanStore;
  /** The snapshot changed: the window is told. */
  onChange(snapshot: AiPlansSnapshot): void;
  /** Open an address in the person's default browser: the sign-in page, the usage page. */
  openExternal(url: string): void | Promise<void>;
  /** The sign-in came back: Pistachio comes to the front. */
  focus?(): void;
  fetch?: typeof fetch;
  /** OpenAI's, unless a test stands in for it. */
  endpoints?: Omit<SiwcEndpoints, "jwks" | "revocation">;
  discoveryUrl?: string;
  listen?: typeof listenForCallback;
  now?: () => number;
  signInTimeoutMs?: number;
}

interface PendingSignIn {
  generation: number;
  attempt: SiwcAttempt;
  listener: CallbackListener;
  timer: ReturnType<typeof setTimeout>;
  returning: SiwcReturning | null;
  endpoints: SiwcEndpoints;
}

/** A sign-in's failure as what the settings card says. Never the provider's own words. */
function signInTrouble(error: unknown, at: string): AiPlanTrouble {
  if (error instanceof SiwcError) {
    const kind = error.kind === "declined" ? "declined" : error.kind === "unreachable" ? "unavailable" : error.kind === "expired" ? "signIn" : "failed";
    return { kind, message: error.message, at };
  }
  return { kind: "failed", message: "The ChatGPT sign-in didn't finish. Try again.", at };
}

export class AiPlanService {
  readonly #store: AiPlanStore;
  readonly #options: AiPlanServiceOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #base: Omit<SiwcEndpoints, "jwks" | "revocation">;
  readonly #planFetch: typeof fetch;
  #endpoints: SiwcEndpoints | null = null;
  #pending: PendingSignIn | null = null;
  #generation = 0;
  /** One refresh at a time: the refresh token is spent by its use, and two would race for its replacement. */
  #refreshing: Promise<string> | null = null;
  #refreshedAt = 0;
  #timers: Array<ReturnType<typeof setTimeout>> = [];
  #disposed = false;

  constructor(options: AiPlanServiceOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#base = options.endpoints ?? OPENAI_ENDPOINTS;
    this.#planFetch = planFetch({
      accessToken: (asked) => this.#accessToken(asked),
      failed: (error) => this.#failed(error),
      used: (usage) => this.#used(usage),
      fetch: this.#fetch,
    });
  }

  /* ------------------------------ what the shell sees ------------------------------ */

  /** The state with no sign-in page out: what `connecting` goes back to. */
  #settled(): Exclude<AiPlanStatus, "connecting"> {
    const kept = this.#store.chatgpt();
    if (kept.needsSignIn) return "signIn";
    if (this.#store.session() === null) return "off";
    return kept.pause ?? "ready";
  }

  snapshot(): AiPlansSnapshot {
    const kept = this.#store.chatgpt();
    const settled = this.#settled();
    const status: AiPlanStatus = this.#pending !== null ? "connecting" : settled;
    const connected = settled !== "off";
    return {
      plans: [
        {
          provider: "chatgpt",
          status,
          chosen: kept.chosen,
          inUse: kept.chosen && status === "ready",
          email: kept.email,
          connectedAt: connected ? kept.connectedAt : null,
          lastUsedAt: kept.lastUsedAt,
          trouble: kept.trouble,
          model: connected ? pickPlanModel(kept.model, kept.models) : null,
          models: connected ? kept.models : [],
          usage: kept.usage,
          welcome: settled === "ready" && !kept.welcomed,
          unconfirmedSignOut: kept.unconfirmedSignOut,
        },
      ],
    };
  }

  #publish(): void {
    if (!this.#disposed) this.#options.onChange(this.snapshot());
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  /* ------------------------------ a turn ------------------------------ */

  /**
   * What the next turn runs on, as far as the plan goes: null when the chat
   * is not on it (not chosen, or signed out) — Pistachio's models, as ever.
   */
  turn(): PlanTurn | null {
    const kept = this.#store.chatgpt();
    if (!kept.chosen) return null;
    switch (this.#settled()) {
      case "off":
        return null;
      case "signIn":
        return { blocked: new PlanError("signIn", PLAN_FAILURE_WORDS.signIn) };
      case "limit":
        return { blocked: new PlanError("limit", PAUSED_FOR_LIMIT) };
      case "ineligible":
        return { blocked: new PlanError("ineligible", PLAN_FAILURE_WORDS.ineligible) };
      case "ready": {
        const model = pickPlanModel(kept.model, kept.models);
        return { model: planLanguageModel({ api: this.#base.api, model, fetch: this.#planFetch }), name: planModelName(model), source: "chatgpt", providerOptions: PLAN_PROVIDER_OPTIONS };
      }
    }
  }

  /* ------------------------------ the session ------------------------------ */

  async #accessToken(asked: { fresh: boolean }): Promise<string> {
    const kept = this.#store.chatgpt();
    const session = this.#store.session();
    if (session === null || kept.needsSignIn || kept.clientId === null) throw new PlanError("signIn", PLAN_FAILURE_WORDS.signIn);
    const now = this.#now();
    // (A token renewed a moment ago and refused all the same is not what the refusal is about.)
    if (asked.fresh && now - this.#refreshedAt < JUST_REFRESHED_MS) return session.accessToken;
    if (!asked.fresh && session.expiresAt - now > REFRESH_AHEAD_MS) return session.accessToken;
    return this.#refresh();
  }

  #refresh(): Promise<string> {
    if (this.#refreshing !== null) return this.#refreshing;
    const run = (async (): Promise<string> => {
      const kept = this.#store.chatgpt();
      const session = this.#store.session();
      if (session === null || kept.clientId === null) throw new PlanError("signIn", PLAN_FAILURE_WORDS.signIn);
      try {
        const tokens = await refreshTokens(this.#fetch, this.#base, { clientId: kept.clientId, refreshToken: session.refreshToken, idToken: session.idToken, scopes: session.scopes }, this.#now());
        this.#refreshedAt = this.#now();
        // The replacement is kept before it is used: the token it replaces is already spent.
        this.#store.setSession(tokens);
        if (!grantsPlanUse(tokens.scopes)) {
          const failure = new PlanError("ineligible", PLAN_FAILURE_WORDS.ineligible);
          this.#failed(failure);
          throw failure;
        }
        return tokens.accessToken;
      } catch (error) {
        if (error instanceof PlanError) throw error;
        if (error instanceof SiwcError && error.kind === "unreachable") {
          // Nothing is concluded from a network that is down: a token still in date is used as it is.
          if (session.expiresAt > this.#now()) return session.accessToken;
          throw new PlanError("unavailable", "ChatGPT's sign-in service couldn't be reached to renew your connection. Check the connection and try again.");
        }
        // The session is over (expired, revoked, disconnected in ChatGPT), or the registration itself is no longer
        // OpenAI's: the tokens are of no more use. The registration is kept unless it is what was refused.
        const registrationGone = error instanceof SiwcError && error.code === "invalid_client";
        this.#store.setSession(null, {
          needsSignIn: true,
          pause: null,
          trouble: { kind: "signIn", message: PLAN_FAILURE_WORDS.signIn, at: this.#iso() },
          ...(registrationGone ? { clientId: null, subject: null } : {}),
        });
        this.#publish();
        throw new PlanError("signIn", PLAN_FAILURE_WORDS.signIn);
      }
    })().finally(() => {
      this.#refreshing = null;
    });
    this.#refreshing = run;
    return run;
  }

  /** A request on the plan failed in a way the person is told of: the state follows what it said. */
  #failed(error: PlanError): void {
    const trouble: AiPlanTrouble = { kind: error.kind, message: error.message, at: this.#iso() };
    if (error.kind === "limit") this.#store.update({ pause: "limit", trouble });
    else if (error.kind === "ineligible") this.#store.update({ pause: "ineligible", trouble });
    else if (error.kind === "signIn") this.#store.update({ needsSignIn: true, trouble });
    else this.#store.update({ trouble });
    this.#publish();
  }

  /** A response finished on the plan: counted, and whatever was wrong before is over. */
  #used(usage: PlanUsage): void {
    const now = new Date(this.#now());
    this.#store.update({ usage: tallyUsage(this.#store.chatgpt().usage, now, usage), lastUsedAt: now.toISOString(), trouble: null });
    this.#publish();
  }

  /* ------------------------------ signing in ------------------------------ */

  async #discovered(): Promise<SiwcEndpoints> {
    if (this.#endpoints === null) this.#endpoints = await discover(this.#fetch, this.#base, this.#options.discoveryUrl ?? OPENAI_DISCOVERY);
    return this.#endpoints;
  }

  #dropPending(): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.listener.close();
  }

  async #connect(fresh: boolean): Promise<void> {
    this.#dropPending();
    if (!this.#store.canKeep()) {
      this.#store.update({ trouble: { kind: "failed", message: NO_KEYCHAIN, at: this.#iso() } });
      this.#publish();
      return;
    }
    if (fresh) await this.#forget();
    let endpoints: SiwcEndpoints;
    try {
      endpoints = await this.#discovered();
    } catch (error) {
      this.#store.update({ trouble: signInTrouble(error, this.#iso()) });
      this.#publish();
      return;
    }
    const kept = this.#store.chatgpt();
    const returning: SiwcReturning | null = kept.clientId === null ? null : { clientId: kept.clientId, idToken: this.#store.session()?.idToken ?? null, email: kept.email };
    const generation = ++this.#generation;
    let listener: CallbackListener;
    try {
      listener = await (this.#options.listen ?? listenForCallback)((search) => this.#callback(generation, search));
    } catch {
      this.#store.update({ trouble: { kind: "failed", message: "Pistachio couldn't listen for ChatGPT's answer on this Mac. Try again.", at: this.#iso() } });
      this.#publish();
      return;
    }
    const attempt = newAttempt(listener.port);
    const timer = setTimeout(() => {
      if (this.#pending?.generation !== generation) return;
      this.#dropPending();
      this.#store.update({ trouble: { kind: "declined", message: "The ChatGPT sign-in wasn't finished. Start it again when you're ready.", at: this.#iso() } });
      this.#publish();
    }, this.#options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    this.#pending = { generation, attempt, listener, timer, returning, endpoints };
    this.#store.update({ trouble: null, unconfirmedSignOut: false });
    this.#publish();
    try {
      // (The address carries the ID token hint: it is opened, never logged.)
      await this.#options.openExternal(authorizeUrl(endpoints, attempt, this.#store.hostId(), returning, { consent: kept.askConsent }));
    } catch {
      if (this.#pending?.generation === generation) this.#dropPending();
      this.#store.update({ trouble: { kind: "failed", message: "Your browser couldn't be opened for the ChatGPT sign-in. Try again.", at: this.#iso() } });
      this.#publish();
    }
  }

  /** The browser came back. What it is told is what the settings card says, too. */
  async #callback(generation: number, search: URLSearchParams): Promise<CallbackOutcome> {
    const pending = this.#pending;
    if (pending === null || pending.generation !== generation) {
      return { ok: false, message: "This sign-in page is no longer the one Pistachio is waiting for. Go back to Pistachio and start again." };
    }
    // (The listener closes itself once this is answered.)
    this.#pending = null;
    clearTimeout(pending.timer);
    try {
      const { code, clientId } = readCallback(search, pending.attempt, pending.returning);
      const now = this.#now();
      const tokens = await exchangeCode(this.#fetch, pending.endpoints, { clientId, code, attempt: pending.attempt }, now);
      if (tokens.idToken === null) throw new SiwcError("rejected", "ChatGPT's answer didn't say who signed in. Start again from Settings.");
      const keys = await fetchKeys(this.#fetch, pending.endpoints.jwks);
      const identity = verifyIdToken(tokens.idToken, { issuer: pending.endpoints.issuer, clientId, nonce: pending.attempt.nonce, keys, now });
      const kept = this.#store.chatgpt();
      // A registration is one account's: its client id is never used with another's tokens.
      if (pending.returning !== null && kept.subject !== null && kept.subject !== identity.subject) {
        void revokeSession(this.#fetch, pending.endpoints, { clientId, refreshToken: tokens.refreshToken });
        throw new SiwcError("mismatch", "ChatGPT signed in a different account than the one connected here. To switch, choose Use a different account.");
      }
      const who = { clientId, subject: identity.subject, email: identity.email ?? kept.email };
      if (!grantsPlanUse(tokens.scopes)) {
        // Signed in, but not for plan usage: nothing is sent on it. The registration stands for the next try, which
        // asks for consent; these tokens are of no use and are ended rather than kept.
        void revokeSession(this.#fetch, pending.endpoints, { clientId, refreshToken: tokens.refreshToken });
        this.#store.setSession(null, { ...who, askConsent: true, needsSignIn: false, pause: null, trouble: { kind: "declined", message: NOT_GRANTED, at: this.#iso() } });
        this.#publish();
        this.#options.focus?.();
        return { ok: false, message: NOT_GRANTED };
      }
      this.#refreshedAt = now;
      this.#store.setSession(tokens, { ...who, connectedAt: this.#iso(), needsSignIn: false, askConsent: false, pause: null, trouble: null, unconfirmedSignOut: false, chosen: true });
      this.#publish();
      this.#options.focus?.();
      void this.#loadModels();
      return { ok: true };
    } catch (error) {
      const trouble = signInTrouble(error, this.#iso());
      this.#store.update({ trouble });
      this.#publish();
      this.#options.focus?.();
      return { ok: false, message: trouble.message };
    }
  }

  /** End the session at OpenAI: true once it confirmed. A network that is down is tried a few times, then left. */
  async #revoke(): Promise<boolean> {
    const kept = this.#store.chatgpt();
    const session = this.#store.session();
    if (session === null || kept.clientId === null) return true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      try {
        const endpoints = await this.#discovered();
        if (await revokeSession(this.#fetch, endpoints, { clientId: kept.clientId, refreshToken: session.refreshToken })) return true;
      } catch {
        // Tried again, then given up on: the tokens are cleared here either way.
      }
    }
    return false;
  }

  /** Sign out: the session ended at OpenAI when it can be, and cleared here whether or not it could. The registration stays. */
  async #disconnect(): Promise<void> {
    this.#dropPending();
    const confirmed = await this.#revoke();
    this.#store.setSession(null, { needsSignIn: false, askConsent: false, pause: null, trouble: null, connectedAt: null, unconfirmedSignOut: !confirmed });
    this.#publish();
  }

  /** Forget the registration too: the next sign-in is a new one, for whichever account signs in. */
  async #forget(): Promise<void> {
    await this.#revoke();
    this.#store.setSession(null, { clientId: null, subject: null, email: null, connectedAt: null, needsSignIn: false, askConsent: false, pause: null, trouble: null, model: null, models: [], unconfirmedSignOut: false });
  }

  /* ------------------------------ the catalog, and the check ------------------------------ */

  /**
   * Read the account's models. It is also the connection's check: the token
   * is renewed when due, and a session that ended in ChatGPT's settings is
   * found here rather than by the next turn.
   */
  async #loadModels(): Promise<void> {
    if (this.#store.session() === null || this.#store.chatgpt().needsSignIn) return;
    const ask = async (fresh: boolean): Promise<Response> => {
      const token = await this.#accessToken({ fresh });
      return this.#fetch(`${this.#base.api}/models`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    };
    try {
      let response = await ask(false);
      if (response.status === 401) response = await ask(true);
      if (response.status === 401) {
        this.#failed(new PlanError("signIn", PLAN_FAILURE_WORDS.signIn));
        return;
      }
      if (!response.ok) return;
      const models = readPlanModels(await response.json());
      if (models.length === 0) return;
      const before = JSON.stringify(this.#store.chatgpt().models);
      if (JSON.stringify(models) === before) return;
      this.#store.update({ models });
      this.#publish();
    } catch {
      // A refresh that ended the session has already said so; anything else is a network that is down.
    }
  }

  /** Look at the connection now and then: once shortly after launch, then every few hours. */
  start(): void {
    const first = setTimeout(() => void this.#loadModels(), FIRST_CHECK_MS);
    first.unref?.();
    const every = setInterval(() => void this.#loadModels(), CHECK_EVERY_MS);
    every.unref?.();
    this.#timers.push(first, every);
  }

  dispose(): void {
    this.#disposed = true;
    this.#dropPending();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
  }

  /* ------------------------------ the shell's requests ------------------------------ */

  async request(request: AiPlanRequest): Promise<AiPlanResponse> {
    switch (request.type) {
      case "get":
        break;
      case "connect":
        await this.#connect(request.fresh === true);
        break;
      case "cancel":
        if (this.#pending !== null) {
          this.#dropPending();
          this.#publish();
        }
        break;
      case "disconnect":
        await this.#disconnect();
        break;
      case "choose":
        this.#store.update({ chosen: request.chosen });
        this.#publish();
        break;
      case "model":
        this.#store.update({ model: request.model });
        this.#publish();
        break;
      case "welcomed":
        this.#store.update({ welcomed: true });
        this.#publish();
        break;
      case "resume":
        // The person says to try the plan again: the pause is theirs to lift. What the next request says decides.
        if (this.#store.chatgpt().pause !== null) {
          this.#store.update({ pause: null, trouble: null });
          this.#publish();
        }
        break;
      case "manageUsage":
        await this.#options.openExternal(CHATGPT_USAGE_URL);
        break;
      case "refresh":
        await this.#loadModels();
        break;
    }
    return { type: "ok", snapshot: this.snapshot() };
  }
}
