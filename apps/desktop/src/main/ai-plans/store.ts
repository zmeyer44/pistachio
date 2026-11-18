/**
 * What this Mac keeps of a person's AI plan (docs/ai-plans.md §2):
 * `<userData>/ai-plans.json`, written whole and atomically (temp + rename,
 * mode 0600).
 *
 * Three kinds of thing are in it, and they end differently:
 *
 * - **The install's host id** (`urn:uuid:…`): made once, before the first
 *   sign-in, and never changed. Opaque; not a secret.
 * - **The registration**: the client id OpenAI issued for this person on
 *   this Mac, with who it is (the ID token's subject, their email). It
 *   outlives a sign-out — the next sign-in is to the same registration.
 * - **The session**: the access, refresh and ID tokens. Sealed with the
 *   Mac's keychain (Electron's safeStorage, as the account's own secrets
 *   are), so the file holds ciphertext; cleared on sign-out and when the
 *   provider says the session is over. When the keychain cannot seal here
 *   nothing is kept at all, and sign-in is refused with the reason.
 *
 * Beside them: the person's choices (whether the chat is on the plan, which
 * model), what last went wrong, and Pistachio's own count of what it sent.
 *
 * The cipher and the clock are handed in: test/ai-plans-store.test.ts.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AiPlanModel, AiPlanTrouble, AiPlanUsageDay } from "@pistachio/shell-contracts/ai-plans";
import { newHostId } from "./siwc";

export const AI_PLANS_FILE = "ai-plans.json";
/** How many days of Pistachio's own count are kept. */
export const USAGE_DAYS_KEPT = 30;

/** What seals the tokens: the Mac's keychain in the app (account/device-store's `safeStorageCipher`), a stand-in under test. */
export interface PlanCipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

/** The tokens of a session, in the clear: in memory only. */
export interface PlanSession {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  /** When the access token lapses, ms since 1970. */
  expiresAt: number;
  scopes: string[];
}

/** Why plan requests are not being sent though a session is held. */
export type PlanPause = "limit" | "ineligible";

/** The ChatGPT plan, as kept. */
export interface ChatGptPlanRecord {
  /** The client id OpenAI issued for this registration (`oaiapp_…`); null before the first sign-in completes. */
  clientId: string | null;
  subject: string | null;
  email: string | null;
  /** Sealed JSON of a `PlanSession`; null when signed out. */
  session: string | null;
  connectedAt: string | null;
  /** The session is over as far as the provider is concerned: sign in again (the registration stands). */
  needsSignIn: boolean;
  /** The last sign-in came back without plan usage: the next one, which the person asks for, asks for consent again. */
  askConsent: boolean;
  pause: PlanPause | null;
  chosen: boolean;
  model: string | null;
  models: AiPlanModel[];
  trouble: AiPlanTrouble | null;
  lastUsedAt: string | null;
  usage: AiPlanUsageDay[];
  /** The first-sign-in confirmation was read. Once, ever: a later sign-in does not show it again. */
  welcomed: boolean;
  unconfirmedSignOut: boolean;
}

interface PlansFile {
  version: 1;
  hostId: string;
  chatgpt: ChatGptPlanRecord;
}

const EMPTY_CHATGPT: ChatGptPlanRecord = {
  clientId: null,
  subject: null,
  email: null,
  session: null,
  connectedAt: null,
  needsSignIn: false,
  askConsent: false,
  pause: null,
  chosen: true,
  model: null,
  models: [],
  trouble: null,
  lastUsedAt: null,
  usage: [],
  welcomed: false,
  unconfirmedSignOut: false,
};

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function readUsage(value: unknown): AiPlanUsageDay[] {
  if (!Array.isArray(value)) return [];
  const days: AiPlanUsageDay[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const day = entry as Record<string, unknown>;
    if (typeof day["day"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day["day"])) continue;
    const count = (key: string): number => (typeof day[key] === "number" && Number.isFinite(day[key]) && day[key] >= 0 ? Math.floor(day[key]) : 0);
    days.push({ day: day["day"], requests: count("requests"), inputTokens: count("inputTokens"), outputTokens: count("outputTokens") });
  }
  return days.slice(-USAGE_DAYS_KEPT);
}

function readModels(value: unknown): AiPlanModel[] {
  if (!Array.isArray(value)) return [];
  const models: AiPlanModel[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = text((entry as Record<string, unknown>)["id"]);
    if (id === null) continue;
    models.push({ id, name: text((entry as Record<string, unknown>)["name"]) ?? id });
  }
  return models;
}

function readTrouble(value: unknown): AiPlanTrouble | null {
  if (typeof value !== "object" || value === null) return null;
  const trouble = value as Record<string, unknown>;
  const kind = trouble["kind"];
  const message = text(trouble["message"]);
  const at = text(trouble["at"]);
  if (message === null || at === null) return null;
  if (kind !== "limit" && kind !== "ineligible" && kind !== "signIn" && kind !== "unavailable" && kind !== "refused" && kind !== "declined" && kind !== "failed") return null;
  return { kind, message, at };
}

function readFile(path: string): PlansFile | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const file = parsed as Record<string, unknown>;
  const hostId = text(file["hostId"]);
  if (hostId === null) return null;
  const kept = typeof file["chatgpt"] === "object" && file["chatgpt"] !== null ? (file["chatgpt"] as Record<string, unknown>) : {};
  const pause = kept["pause"];
  return {
    version: 1,
    hostId,
    chatgpt: {
      clientId: text(kept["clientId"]),
      subject: text(kept["subject"]),
      email: text(kept["email"]),
      session: text(kept["session"]),
      connectedAt: text(kept["connectedAt"]),
      needsSignIn: kept["needsSignIn"] === true,
      askConsent: kept["askConsent"] === true,
      pause: pause === "limit" || pause === "ineligible" ? pause : null,
      chosen: kept["chosen"] !== false,
      model: text(kept["model"]),
      models: readModels(kept["models"]),
      trouble: readTrouble(kept["trouble"]),
      lastUsedAt: text(kept["lastUsedAt"]),
      usage: readUsage(kept["usage"]),
      welcomed: kept["welcomed"] === true,
      unconfirmedSignOut: kept["unconfirmedSignOut"] === true,
    },
  };
}

/** The day on this Mac's clock, `YYYY-MM-DD`. */
export function localDay(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** One finished response, added to its day; days past the window dropped. */
export function tallyUsage(days: readonly AiPlanUsageDay[], now: Date, used: { inputTokens: number; outputTokens: number }): AiPlanUsageDay[] {
  const today = localDay(now);
  const last = days[days.length - 1];
  const next =
    last !== undefined && last.day === today
      ? [...days.slice(0, -1), { day: today, requests: last.requests + 1, inputTokens: last.inputTokens + used.inputTokens, outputTokens: last.outputTokens + used.outputTokens }]
      : [...days, { day: today, requests: 1, inputTokens: used.inputTokens, outputTokens: used.outputTokens }];
  const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (USAGE_DAYS_KEPT - 1));
  const floor = localDay(oldest);
  return next.filter((entry) => entry.day >= floor).slice(-USAGE_DAYS_KEPT);
}

export class AiPlanStore {
  readonly #path: string;
  readonly #cipher: PlanCipher;
  #file: PlansFile;
  /** The open session, decrypted once: null when signed out or when the keychain can no longer open it. */
  #session: PlanSession | null = null;

  constructor(path: string, cipher: PlanCipher) {
    this.#path = path;
    this.#cipher = cipher;
    this.#file = readFile(path) ?? { version: 1, hostId: newHostId(), chatgpt: { ...EMPTY_CHATGPT } };
    const sealed = this.#file.chatgpt.session;
    if (sealed !== null) {
      this.#session = this.#open(sealed);
      // A session this Mac can no longer open (a restored profile, another keychain) is no session: sign in again.
      if (this.#session === null) this.#file.chatgpt = { ...this.#file.chatgpt, session: null, needsSignIn: this.#file.chatgpt.clientId !== null };
    }
  }

  #open(sealed: string): PlanSession | null {
    if (!this.#cipher.available()) return null;
    try {
      const parsed = JSON.parse(this.#cipher.decrypt(sealed)) as Partial<PlanSession>;
      if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string" || typeof parsed.expiresAt !== "number") return null;
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        idToken: typeof parsed.idToken === "string" ? parsed.idToken : null,
        expiresAt: parsed.expiresAt,
        scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      };
    } catch {
      return null;
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${String(process.pid)}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.#file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.#path);
    try {
      chmodSync(this.#path, 0o600);
    } catch {
      // The mode was set as the file was made; a filesystem without modes keeps what it has.
    }
  }

  /** Whether a session can be kept here at all: the keychain seals. */
  canKeep(): boolean {
    return this.#cipher.available();
  }

  /** This install's host id: the same for every sign-in from this Mac. */
  hostId(): string {
    return this.#file.hostId;
  }

  chatgpt(): Readonly<ChatGptPlanRecord> {
    return this.#file.chatgpt;
  }

  /** The tokens, in the clear; null when signed out. */
  session(): PlanSession | null {
    return this.#session;
  }

  /** Change what is kept of the ChatGPT plan, and write it. The session is not set here: `setSession`. */
  update(patch: Partial<Omit<ChatGptPlanRecord, "session">>): void {
    this.#file = { ...this.#file, chatgpt: { ...this.#file.chatgpt, ...patch } };
    this.#write();
  }

  /**
   * Keep a session (a sign-in, or a refresh's replacement tokens), or clear
   * it (null). Throws when the keychain cannot seal: a token is never
   * written in the clear, and the caller says so to the person.
   */
  setSession(session: PlanSession | null, patch: Partial<Omit<ChatGptPlanRecord, "session">> = {}): void {
    if (session !== null && !this.#cipher.available()) throw new Error("This Mac's keychain is not available, so a ChatGPT sign-in cannot be kept safely here.");
    this.#session = session;
    this.#file = { ...this.#file, chatgpt: { ...this.#file.chatgpt, ...patch, session: session === null ? null : this.#cipher.encrypt(JSON.stringify(session)) } };
    this.#write();
  }
}
