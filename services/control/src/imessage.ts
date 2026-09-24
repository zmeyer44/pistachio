/**
 * The iMessage edge: BlueBubbles transport plus the deterministic conversion
 * between the agent's typed questions and a plain text conversation.
 *
 * Nothing in here knows how an agent runs. It sends a small, explicit set of
 * connector events (OTP, question, secure-information request, completion)
 * and turns one incoming text into an answer value. That boundary is
 * intentional: traces and intermediate assistant messages never reach
 * BlueBubbles.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentQuestion } from "@pistachio/protocol";

export const IMESSAGE_OTP_TTL_MS = 10 * 60 * 1000;
export const IMESSAGE_OTP_MAX_ATTEMPTS = 5;
/** A phone invitation is short-lived and can be redeemed only once. */
export const IMESSAGE_ONBOARDING_TTL_MS = 30 * 60 * 1000;
/** A question older than this cannot consume an unrelated future text. */
export const IMESSAGE_PENDING_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
export const BLUEBUBBLES_TIMEOUT_MS = 10_000;

export interface BlueBubblesOptions {
  serverUrl: string;
  password: string;
  webhookSecret: string;
  otpSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface BlueBubblesInbound {
  deliveryId: string;
  phoneE164: string;
  text: string;
}

export type ParsedQuestionAnswer =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" };

/**
 * Accept international E.164, plus the two common US forms a settings field
 * receives. Formatting punctuation is ignored; extensions are not.
 */
export function normalizePhoneNumber(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "" || /[a-z]/iu.test(trimmed)) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/gu, "");
  const international = hasPlus ? digits : digits.length === 10 ? `1${digits}` : digits;
  if (!/^[1-9]\d{7,14}$/u.test(international)) return null;
  return `+${international}`;
}

export function maskPhoneNumber(phoneE164: string): string {
  const tail = phoneE164.slice(-4);
  return `••• ••• ${tail}`;
}

/** Render model-authored Markdown as readable plain text for iMessage. */
export function toIMessagePlainText(markdown: string): string {
  let text = markdown.replace(/\r\n?/gu, "\n");
  text = text
    .replace(/^[ \t]*```[^\n]*\n?/gmu, "")
    .replace(/^[ \t]*~~~[^\n]*\n?/gmu, "")
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu,
      (_match, alt: string, url: string) =>
        url.toLowerCase().startsWith("attachment://") ? alt : alt === "" ? url : `${alt} (${url})`,
    )
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu,
      (_match, label: string, url: string) =>
        url.toLowerCase().startsWith("attachment://") ? label : label === url ? label : `${label} (${url})`,
    )
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/giu, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gmu, "")
    .replace(/^[ \t]*[-+*][ \t]+\[x\][ \t]+/gimu, "☑ ")
    .replace(/^[ \t]*[-+*][ \t]+\[ \][ \t]+/gmu, "☐ ")
    .replace(/^[ \t]*[-+*][ \t]+/gmu, "• ")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gmu, "")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
    .replace(/__([^_\n]+)__/gu, "$1")
    .replace(/~~([^~\n]+)~~/gu, "$1")
    .replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s.,!?;:)\]}])/gmu, "$1$2")
    .replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s.,!?;:)\]}])/gmu, "$1$2")
    .replace(/<\/?[a-z][^>]*>/giu, "")
    .replace(/\\([\\`*{}[\]()#+\-.!_>])/gu, "$1")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n");
  return text.trim();
}

export function formatIMessageQuestion(question: AgentQuestion): string {
  const prompt = toIMessagePlainText(question.prompt);
  const description = toIMessagePlainText(question.description);
  const intro = ["Pistachio needs your input", prompt, description]
    .filter((part, index, parts) => part !== "" && (index !== 2 || part !== parts[1]))
    .join("\n\n");
  if (question.input?.type === "text") return `${intro}\n\nReply with your answer.`;
  const choices = question.choices
    .map((choice, index) => {
      const label = toIMessagePlainText(choice.label);
      const detail = toIMessagePlainText(choice.description);
      return `${String(index + 1)}. ${label}${detail === "" || detail === label ? "" : ` — ${detail}`}`;
    })
    .join("\n");
  return `${intro}\n\n${choices}\n\nReply with a number, or in your own words.`;
}

export function formatIMessageCompletion(text: string): string {
  const plain = toIMessagePlainText(text);
  return `Pistachio finished your task${plain === "" ? "." : `:\n\n${plain}`}`;
}

export function formatIMessageOnboarding(onboardingUrl: string): string {
  return [
    "Welcome to Pistachio.",
    "Connect this number to an existing account or create a new one:",
    onboardingUrl,
    "This secure link expires in 30 minutes and works once. Do not share it.",
  ].join("\n\n");
}

export function formatIMessageCredentialRequest(input: {
  siteOrigin: string;
  fieldLabels: string[];
  captureUrl: string;
  expiresAt: string;
}): string {
  const labels = input.fieldLabels
    .map((label) => toIMessagePlainText(label))
    .filter((label) => label !== "")
    .join(", ");
  return [
    "Pistachio needs secure information for:",
    input.siteOrigin,
    labels === "" ? "" : `Requested fields: ${labels}`,
    `Open the secure form:\n${input.captureUrl}`,
    `Do not reply with sensitive information. This link expires at ${input.expiresAt}.`,
  ].filter((part) => part !== "").join("\n\n");
}

/**
 * A reply that names an option (by number or exact text) resolves to that
 * choice's value. Anything else is passed through verbatim: both executors
 * hand an unrecognized answer to the model as the person's own words, which
 * reads a text like "2 people, around 8pm" far better than a retry prompt.
 */
export function parseIMessageQuestionAnswer(question: AgentQuestion, input: string): ParsedQuestionAnswer {
  const value = input.trim();
  if (value === "") return { ok: false, reason: "empty" };
  if (question.input?.type === "text") return { ok: true, value };

  const numbered = /^(?:option\s*)?(\d+)[.)]?$/iu.exec(value);
  const numberedChoice = numbered === null ? undefined : question.choices[Number(numbered[1]) - 1];
  if (numberedChoice !== undefined) return { ok: true, value: numberedChoice.value };
  const folded = value.toLocaleLowerCase("en-US");
  const matches = question.choices.filter(
    (choice) =>
      choice.label.trim().toLocaleLowerCase("en-US") === folded ||
      choice.value.trim().toLocaleLowerCase("en-US") === folded,
  );
  return { ok: true, value: matches.length === 1 ? matches[0]?.value ?? value : value };
}

function serviceUrl(base: URL, path: string): URL {
  const url = new URL(base.href);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
  return url;
}

function deliveryGuid(idempotencyKey: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BlueBubblesConnector {
  readonly webhookSecret: string;
  readonly otpSecret: string;
  readonly #serverUrl: URL;
  readonly #password: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: BlueBubblesOptions) {
    const url = new URL(options.serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BLUEBUBBLES_SERVER_URL must be HTTP(S)");
    if (options.password === "" || options.webhookSecret === "" || options.otpSecret === "") {
      throw new Error("BlueBubbles password, webhook secret, and OTP secret are required");
    }
    this.#serverUrl = url;
    this.#password = options.password;
    this.webhookSecret = options.webhookSecret;
    this.otpSecret = options.otpSecret;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? BLUEBUBBLES_TIMEOUT_MS;
  }

  verifyWebhookSecret(supplied: string | undefined): boolean {
    if (supplied === undefined || supplied === "") return false;
    const actual = createHash("sha256").update(supplied).digest();
    const expected = createHash("sha256").update(this.webhookSecret).digest();
    return timingSafeEqual(actual, expected);
  }

  parseWebhook(payload: unknown): BlueBubblesInbound | null {
    if (!isRecord(payload) || payload["type"] !== "new-message" || !isRecord(payload["data"])) return null;
    const data = payload["data"];
    if (data["isFromMe"] === true || typeof data["guid"] !== "string" || typeof data["text"] !== "string") return null;
    if (!Array.isArray(data["chats"]) || !isRecord(data["chats"][0])) return null;
    const chatGuid = data["chats"][0]["guid"];
    if (typeof chatGuid !== "string" || !chatGuid.includes(";-;")) return null;
    if (!isRecord(data["handle"]) || typeof data["handle"]["address"] !== "string") return null;
    const phoneE164 = normalizePhoneNumber(data["handle"]["address"]);
    if (phoneE164 === null) return null;
    return { deliveryId: data["guid"], phoneE164, text: data["text"] };
  }

  sendOtp(phoneE164: string, code: string, challengeId: string): Promise<void> {
    return this.sendText(phoneE164, `Your Pistachio verification code is ${code}. It expires in 10 minutes.`, `otp:${challengeId}`);
  }

  sendOnboardingLink(phoneE164: string, onboardingUrl: string, deliveryId: string): Promise<void> {
    return this.sendText(phoneE164, formatIMessageOnboarding(onboardingUrl), `onboarding:${deliveryId}`);
  }

  sendTaskStarted(phoneE164: string, runId: string, deliveryId: string): Promise<void> {
    return this.sendText(
      phoneE164,
      "On it — I started a Pistachio task. I’ll message you here if I need anything and when it’s done.",
      `task-started:${runId}:${deliveryId}`,
    );
  }

  sendTaskContinued(phoneE164: string, runId: string, deliveryId: string): Promise<void> {
    return this.sendText(
      phoneE164,
      "Got it — I added that to your current Pistachio task.",
      `task-continued:${runId}:${deliveryId}`,
    );
  }

  sendInvalidTask(phoneE164: string, deliveryId: string): Promise<void> {
    return this.sendText(
      phoneE164,
      "Please send a non-empty task under 16,384 characters.",
      `task-invalid:${deliveryId}`,
    );
  }

  sendCloudSetupRequired(phoneE164: string, appUrl: string, deliveryId: string): Promise<void> {
    return this.sendText(
      phoneE164,
      `Your number is connected, but the cloud browser still needs to be turned on. Finish setup here:\n${appUrl}`,
      `cloud-setup:${deliveryId}`,
    );
  }

  sendQuestion(phoneE164: string, runId: string, question: AgentQuestion): Promise<void> {
    return this.sendText(phoneE164, formatIMessageQuestion(question), `question:${runId}:${question.id}`);
  }

  sendCredentialRequest(
    phoneE164: string,
    runId: string,
    captureId: string,
    input: Parameters<typeof formatIMessageCredentialRequest>[0],
  ): Promise<void> {
    return this.sendText(
      phoneE164,
      formatIMessageCredentialRequest(input),
      `credentials:${runId}:${captureId}`,
    );
  }

  sendCompletion(phoneE164: string, runId: string, text: string, completionId: string): Promise<void> {
    return this.sendText(phoneE164, formatIMessageCompletion(text), `completion:${runId}:${completionId}`);
  }

  sendInvalidAnswer(phoneE164: string, runId: string, question: AgentQuestion, deliveryId: string): Promise<void> {
    return this.sendText(
      phoneE164,
      "Please reply with a non-empty answer under 16,384 characters.",
      `invalid:${runId}:${question.id}:${deliveryId}`,
    );
  }

  sendAnswerAccepted(phoneE164: string, runId: string, question: AgentQuestion, deliveryId: string): Promise<void> {
    // The person just typed the answer; echoing the question back reads as
    // if it were being asked again.
    return this.sendText(phoneE164, "Got it.", `answer-accepted:${runId}:${question.id}:${deliveryId}`);
  }

  sendAnswerClosed(phoneE164: string, runId: string, question: AgentQuestion, deliveryId: string): Promise<void> {
    return this.sendText(
      phoneE164,
      `That question is no longer waiting for an answer:\n\n${questionReference(question)}\n\nOpen Pistachio to see the latest task state.`,
      `answer-closed:${runId}:${question.id}:${deliveryId}`,
    );
  }

  sendAnswerRetry(phoneE164: string, runId: string, question: AgentQuestion, deliveryId: string): Promise<void> {
    return this.sendText(
      phoneE164,
      `I couldn't apply that answer yet. Please reply again for:\n\n${questionReference(question)}`,
      `answer-retry:${runId}:${question.id}:${deliveryId}`,
    );
  }

  sendNoPendingQuestion(phoneE164: string, deliveryId: string): Promise<void> {
    return this.sendText(
      phoneE164,
      "There isn't a Pistachio question waiting for an answer right now. Open Pistachio to see your latest tasks.",
      `answer-none:${deliveryId}`,
    );
  }

  async sendText(phoneE164: string, text: string, idempotencyKey: string = randomUUID()): Promise<void> {
    const url = serviceUrl(this.#serverUrl, "api/v1/message/text");
    url.searchParams.set("password", this.#password);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chatGuid: `iMessage;-;${phoneE164}`,
          message: text,
          method: "private-api",
          tempGuid: deliveryGuid(idempotencyKey),
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new Error("BlueBubbles send timed out");
      throw error;
    }
    if (!response.ok) throw new Error(`BlueBubbles send failed with HTTP ${String(response.status)}`);
  }
}

function questionReference(question: AgentQuestion): string {
  const prompt = toIMessagePlainText(question.prompt);
  return prompt.length <= 320 ? prompt : `${prompt.slice(0, 319).trimEnd()}…`;
}

export function blueBubblesOptionsFromEnv(env: Record<string, string | undefined>): BlueBubblesOptions | null {
  const keys = [
    "BLUEBUBBLES_SERVER_URL",
    "BLUEBUBBLES_PASSWORD",
    "BLUEBUBBLES_WEBHOOK_SECRET",
    "IMESSAGE_OTP_SECRET",
  ] as const;
  const values = keys.map((key) => env[key]?.trim() ?? "");
  if (values.every((value) => value === "")) return null;
  const missing = keys.filter((_key, index) => values[index] === "");
  if (missing.length > 0) throw new Error(`iMessage configuration is incomplete: ${missing.join(", ")}`);
  return {
    serverUrl: values[0] ?? "",
    password: values[1] ?? "",
    webhookSecret: values[2] ?? "",
    otpSecret: values[3] ?? "",
  };
}
