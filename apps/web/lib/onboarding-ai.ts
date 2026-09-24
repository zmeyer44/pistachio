"use client";

/**
 * The three model calls the walkthrough makes, answered on THIS side of the
 * bridge (docs/web-browser-design.md §14).
 *
 * `getAiStatus`, `transcribeSpeech` and `extractOnboardingIntake` are
 * `ShellApi` members like any other, and a desktop host answers them by
 * running the AI SDK next to the tabs. The cloud host cannot: control
 * forbids a `cloud` device from `/v1/ai/*` — the proxy is device-bearer and
 * this worker is not the person — so a session host has no model to reach.
 * The web device does: it is a `platform: "web"` device with a token of its
 * own, and the same proxy answers it. So the browser tab runs the calls
 * itself, over its own token, and installs them on `WsShellApi` where the
 * shared shell finds them.
 *
 * The logic is not written twice: `@pistachio/agent-runtime/onboarding` is
 * the desktop's own, with the models handed in rather than looked up.
 */

import { createGateway } from "ai";
import {
  extractIntake,
  transcribeIntroduction,
  type OnboardingIntake,
} from "@pistachio/agent-runtime/onboarding";
import type { AiProviderStatus, SpeechInput } from "@pistachio/shell-contracts/ipc";
import { MAX_INTRO_AUDIO_BYTES } from "@pistachio/shell-contracts/onboarding";
import { CONTROL_URL } from "@pistachio/web-account";

/** The route control's model proxy answers on (services/control/src/ai-proxy.ts). */
const AI_PROXY_PATH = "/v1/ai";

/**
 * The models, by the same names the desktop uses, so a deployment that pins
 * one pins it for both. The defaults match `apps/desktop/src/main/model-provider.ts`.
 */
export const STT_MODEL = process.env["NEXT_PUBLIC_PISTACHIO_STT_MODEL"]?.trim() || "openai/whisper-1";
export const AGENT_MODEL = process.env["NEXT_PUBLIC_PISTACHIO_AGENT_MODEL"]?.trim() || "openai/gpt-5.6-terra";

/** What the About step is told when there is no token to reach the proxy with. */
const NOT_SIGNED_IN = "This browser is not signed in, so there is no model to listen with. Type your introduction instead.";

/**
 * A recording longer than the wizard's cap is refused HERE rather than sent:
 * the bytes would only be refused by the proxy after crossing the network.
 */
const TOO_LONG = "That recording is too long to send. Record a shorter introduction, or type it instead.";

/** The three members the web answers for itself. */
export interface OnboardingAi {
  getAiStatus(): Promise<AiProviderStatus>;
  transcribeSpeech(input: SpeechInput): Promise<string>;
  extractOnboardingIntake(transcript: string): Promise<OnboardingIntake>;
}

/** base64 from `blobToBase64` in the shell's recorder, back to bytes. */
function decodeAudio(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/**
 * The gateway, aimed at control's proxy under this browser's device token.
 * The SDK insists on some credential before it will send anything; the
 * placeholder is overwritten on every request and never reaches the wire —
 * exactly as `accountFetch` does it on the Mac.
 */
function gateway(getToken: () => Promise<string | null>) {
  const proxied: typeof fetch = async (input, init) => {
    const token = await getToken();
    if (token === null) throw new Error(NOT_SIGNED_IN);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return createGateway({
    baseURL: `${CONTROL_URL}${AI_PROXY_PATH}`,
    apiKey: "device-token",
    fetch: proxied,
  });
}

/**
 * The three answers, for a session that holds a device token. `available`
 * is the same question the desktop asks — is this device enrolled, and does
 * it know where control is — because the models come with the account and
 * no key is involved either way.
 */
export function createOnboardingAi(getToken: () => Promise<string | null>): OnboardingAi {
  return {
    async getAiStatus(): Promise<AiProviderStatus> {
      const token = await getToken().catch(() => null);
      const available = token !== null && CONTROL_URL !== "";
      return { available, controlUrl: available ? CONTROL_URL : null };
    },

    async transcribeSpeech(input: SpeechInput): Promise<string> {
      // The same two guards the desktop's IPC applies before it sends
      // anything (apps/desktop/src/main/index.ts): a recording within the
      // wizard's cap, and something that says it is audio.
      if (!/^audio\/[\w.+-]+(;.*)?$/u.test(input.mediaType)) throw new Error("That is not an audio recording.");
      const audio = decodeAudio(input.data);
      if (audio.byteLength === 0 || audio.byteLength > MAX_INTRO_AUDIO_BYTES) throw new Error(TOO_LONG);
      const token = await getToken();
      if (token === null) throw new Error(NOT_SIGNED_IN);
      const provider = gateway(getToken);
      return transcribeIntroduction({
        model: provider.transcriptionModel(STT_MODEL),
        // The endpoint first, then a chat model that hears audio — for a
        // gateway that has the model but not its transcription route.
        fallbackModel: provider.languageModel(AGENT_MODEL),
        audio,
        mediaType: input.mediaType,
      });
    },

    async extractOnboardingIntake(transcript: string): Promise<OnboardingIntake> {
      // Never throws, by contract: with no token the heuristic read of the
      // text is what prefills the fields the person is about to edit.
      const token = await getToken().catch(() => null);
      return extractIntake({
        model: token === null ? null : gateway(getToken).languageModel(AGENT_MODEL),
        transcript,
      });
    },
  };
}
