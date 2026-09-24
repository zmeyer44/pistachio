/**
 * Which model the agent runs on, which embeds its memory, and which speaks.
 *
 * One place, because everything reaches a model the same way: through the
 * control plane's `/v1/ai/*` proxy (services/control/src/ai-proxy.ts),
 * bearing this Mac's device token. No provider key lives on the device —
 * the operator's key sits on the server — so "is a model available" is the
 * same question as "is this Mac enrolled". Embeddings and speech are
 * optional — with no model reachable memory search is lexical and
 * read-aloud uses the device voice, and nothing else changes.
 *
 * The AI SDK still runs here: the agent loop drives the tabs beside it.
 * Only the credential and the wire hop moved.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createGateway,
  type EmbeddingModel,
  type Experimental_EvaluationModel,
  type LanguageModel,
  type SpeechModel,
  type TranscriptionModel,
} from "ai";
import { config as loadEnv } from "dotenv";
import type { AiProviderStatus } from "@pistachio/shell-contracts/ipc";

const DEFAULT_MODEL = "openai/gpt-5.6-terra";
const DEFAULT_ARTIFACT_MODEL = "anthropic/claude-opus-5";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_SPEECH_MODEL = "openai/tts-1";
const DEFAULT_TRANSCRIPTION_MODEL = "openai/whisper-1";
const DEFAULT_INTENT_MODEL = "typesafe-ai/jev";
/** Tidy sorts a few dozen tab titles and names groups: a small, fast language model's work. */
const DEFAULT_TIDY_MODEL = "anthropic/claude-haiku-4.5";
/** The daily brief's one written sentence: a small, fast language model's work too. */
const DEFAULT_BRIEF_MODEL = "anthropic/claude-haiku-4.5";

/** The route the desktop's provider is given as its base URL. */
export const AI_PROXY_PATH = "/v1/ai";

/**
 * What the account layer lends the model layer: where control is and the
 * device token to reach it with. `getToken` answers null until this Mac is
 * enrolled, and after its enrollment is revoked.
 */
export interface AiSession {
  controlUrl: string;
  enrolled: () => boolean;
  getToken: () => Promise<string | null>;
}

let envLoaded = false;
let session: AiSession | null = null;

export function loadWorkspaceEnvironment(): void {
  if (envLoaded) return;
  envLoaded = true;
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), "../../.env"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path !== undefined) loadEnv({ path, quiet: true });
}

/** Called once the account services exist; null when they could not start. */
export function setAiSession(next: AiSession | null): void {
  session = next;
}

export function modelName(): string {
  return process.env["PISTACHIO_AGENT_MODEL"]?.trim() || DEFAULT_MODEL;
}

/**
 * The model a console turn runs on when the router sends it down the
 * answer path (docs/console-routing.md): the agent's own model unless
 * `PISTACHIO_ANSWER_MODEL` names another. The quick path is quick because
 * it skips the browser round trips, not because it thinks less; a smaller
 * model here is a choice the operator makes, not a default.
 */
export function answerModelName(): string {
  return process.env["PISTACHIO_ANSWER_MODEL"]?.trim() || modelName();
}

/**
 * Whether the console asks the evaluation model which path a turn takes.
 * `PISTACHIO_TURN_ROUTER=off` sends every turn down the browser path, as
 * before the router; the router is also off whenever the intent model is
 * (`PISTACHIO_INTENT_MODEL=off`), since it is that model it asks.
 */
export function turnRouterEnabled(): boolean {
  const configured = process.env["PISTACHIO_TURN_ROUTER"]?.trim();
  return !(configured === "off" || configured === "0" || configured === "false");
}

/** The model that writes artifact HTML: a coding specialist, not the agent's. */
export function artifactModelName(): string {
  return process.env["PISTACHIO_ARTIFACT_MODEL"]?.trim() || DEFAULT_ARTIFACT_MODEL;
}

/** `PISTACHIO_MEMORY_EMBEDDING_MODEL=off` turns vectors off outright. */
export function embeddingModelName(): string | null {
  const configured = process.env["PISTACHIO_MEMORY_EMBEDDING_MODEL"]?.trim();
  if (configured === "off" || configured === "0" || configured === "false") return null;
  return configured || DEFAULT_EMBEDDING_MODEL;
}

/**
 * The evaluation model the address bar asks what typed prose means
 * (docs/smart-suggestions.md). `PISTACHIO_INTENT_MODEL=off` turns the whole
 * feature off for this Mac whatever the setting says — the host then answers
 * null and the bar keeps its own heuristic order.
 */
export function intentModelName(): string | null {
  const configured = process.env["PISTACHIO_INTENT_MODEL"]?.trim();
  if (configured === "off" || configured === "0" || configured === "false") return null;
  return configured || DEFAULT_INTENT_MODEL;
}

/**
 * The language model Tidy asks which tabs belong together (docs/tab-tidy.md
 * §4). `PISTACHIO_TIDY_MODEL=off` keeps Tidy to the clock alone on this Mac
 * whatever the setting says.
 */
export function tidyModelName(): string | null {
  const configured = process.env["PISTACHIO_TIDY_MODEL"]?.trim();
  if (configured === "off" || configured === "0" || configured === "false") return null;
  return configured || DEFAULT_TIDY_MODEL;
}

/**
 * The language model that writes the daily brief's headline (docs/reports.md).
 * `PISTACHIO_BRIEF_MODEL=off` leaves the headline to the template; the page
 * itself is composed by the evaluation model (`PISTACHIO_INTENT_MODEL`).
 */
export function briefModelName(): string | null {
  const configured = process.env["PISTACHIO_BRIEF_MODEL"]?.trim();
  if (configured === "off" || configured === "0" || configured === "false") return null;
  return configured || DEFAULT_BRIEF_MODEL;
}

export function speechModelName(): string {
  return process.env["PISTACHIO_TTS_MODEL"]?.trim() || DEFAULT_SPEECH_MODEL;
}

export function transcriptionModelName(): string {
  return process.env["PISTACHIO_STT_MODEL"]?.trim() || DEFAULT_TRANSCRIPTION_MODEL;
}

/**
 * Whether a model can be reached right now: this Mac holds a device token —
 * a signed-in account's, or the anonymous account's it is given when nobody
 * has signed in (docs/anonymous-accounts.md).
 */
export function aiAvailable(): boolean {
  return session !== null && session.enrolled();
}

/** What the page learns; the token itself never leaves main. */
export function aiProviderStatus(): AiProviderStatus {
  return {
    available: aiAvailable(),
    controlUrl: session?.controlUrl ?? null,
  };
}

/**
 * A model request that hangs mid-flight otherwise hangs the whole agent
 * run, silently: there is no timeout below this point, and the person's
 * only recourse is to give up and interrupt. Every request runs under this
 * fetch instead — a generous deadline per attempt, one retry when the
 * deadline (not the caller) aborted, then a plain error so the run fails
 * visibly rather than sitting on a dead connection.
 */
export const MODEL_REQUEST_TIMEOUT_MS = 180_000;

/**
 * No device token here: control could not be reached to make this Mac's
 * anonymous account (or the keychain cannot keep one), and nobody signed in.
 */
export const NOT_SIGNED_IN =
  "Pistachio's models can't be reached from this Mac yet. Check the connection and try again, or sign in under Settings → Account.";

/**
 * The fetch every model request goes through: the current device token in
 * `Authorization` (refreshed when due — a run can outlive a token), then the
 * bounded, once-retried send. Pure over its inputs so the swap is testable
 * without a control plane.
 */
export function accountFetch(
  current: () => AiSession | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = MODEL_REQUEST_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    const active = current();
    const token = active === null || !active.enrolled() ? null : await active.getToken();
    if (token === null) throw new Error(NOT_SIGNED_IN);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    const caller = init?.signal ?? null;
    for (let attempt = 1; ; attempt += 1) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = caller === null ? deadline : AbortSignal.any([caller, deadline]);
      try {
        return await fetchImpl(input, { ...init, headers, signal });
      } catch (error: unknown) {
        if (caller?.aborted === true) throw error;
        if (!deadline.aborted) throw error;
        // Only a body that can be resent is retried; the SDK sends strings.
        const resendable = init?.body === undefined || typeof init.body === "string";
        if (attempt >= 2 || !resendable)
          throw new Error(
            `The model did not answer within ${String(timeoutMs / 1000)}s` +
              (attempt >= 2 ? " (twice in a row)." : "."),
          );
      }
    }
  };
}

const proxiedFetch = accountFetch(() => session);

/**
 * The gateway provider, aimed at control. The SDK insists on some
 * credential before it will send anything; the placeholder is overwritten
 * by `accountFetch` on every request and never reaches the wire.
 */
function provider() {
  loadWorkspaceEnvironment();
  const active = session;
  if (active === null || !active.enrolled()) throw new Error(NOT_SIGNED_IN);
  return createGateway({
    baseURL: `${active.controlUrl.replace(/\/+$/, "")}${AI_PROXY_PATH}`,
    apiKey: "device-token",
    fetch: proxiedFetch,
  });
}

export function configuredModel(): LanguageModel {
  return provider().languageModel(modelName());
}

export function configuredArtifactModel(): LanguageModel {
  return provider().languageModel(artifactModelName());
}

export function configuredAnswerModel(): LanguageModel {
  return provider().languageModel(answerModelName());
}

/** Null when signed out or the model is turned off — never a throw. */
export function configuredEmbeddingModel(): { id: string; model: EmbeddingModel } | null {
  const id = embeddingModelName();
  if (id === null || !aiAvailable()) return null;
  return { id, model: provider().embeddingModel(id) };
}

/**
 * Null when signed out or the model is turned off — never a throw.
 *
 * A keystroke is not a run: every request under this model is bounded by
 * `ADDRESS_INTENT_LIMITS.timeoutMs` at the caller, and `accountFetch`'s own
 * three-minute deadline is never what ends one. The caller's signal
 * short-circuits that fetch, which is exactly what a superseded keystroke
 * needs.
 */
export function configuredIntentModel(): { id: string; model: Experimental_EvaluationModel } | null {
  const id = intentModelName();
  if (id === null || !aiAvailable()) return null;
  return { id, model: provider().evaluationModel(id) };
}

/** Null when signed out or the model is turned off — never a throw. */
export function configuredTidyModel(): { id: string; model: LanguageModel } | null {
  const id = tidyModelName();
  if (id === null || !aiAvailable()) return null;
  return { id, model: provider().languageModel(id) };
}

/** Null when signed out or the model is turned off — never a throw. */
export function configuredBriefModel(): { id: string; model: LanguageModel } | null {
  const id = briefModelName();
  if (id === null || !aiAvailable()) return null;
  return { id, model: provider().languageModel(id) };
}

/** Null when signed out — never a throw. */
export function configuredSpeechModel(): SpeechModel | null {
  return aiAvailable() ? provider().speechModel(speechModelName()) : null;
}

/** Null when signed out — never a throw. */
export function configuredTranscriptionModel(): TranscriptionModel | null {
  return aiAvailable() ? provider().transcriptionModel(transcriptionModelName()) : null;
}
