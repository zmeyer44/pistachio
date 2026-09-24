/**
 * The model-backed half of the first-run walkthrough: turning a spoken
 * introduction into text, and text into the name, bio and facts that seed
 * the agent's memory.
 *
 * It lives here, beside the memory shapes it writes into, because BOTH
 * hosts need it (docs/web-browser-design.md §14). On a Mac
 * `apps/desktop/src/main/onboarding.ts` calls it with the gateway models
 * the account lends it; in a browser tab the web app calls it with a
 * gateway of its own, pointed at the same `/v1/ai/*` proxy under the web
 * device's token. Nothing here knows which: the models are arguments, and
 * there is no `process.env`, no Electron and no DOM in this file.
 *
 * Both halves are best-effort in the way memory's learner is.
 * Transcription needs a model — the transcription endpoint first, then any
 * chat model that hears audio — and says so plainly when there is none, so
 * the wizard can offer typing. Extraction falls back to a heuristic read of
 * the text (`heuristicIntake`) when no model answers, and NEVER throws; the
 * person edits the result before anything is written, whichever produced it.
 */

import { generateObject, generateText, transcribe, type LanguageModel, type TranscriptionModel } from "ai";
import { z } from "zod";
import {
  looksSensitive,
  MAX_MEMORY_CONTENT,
  MAX_MEMORY_LABEL,
  MEMORY_BUCKETS,
  MEMORY_KINDS,
  type MemoryBucket,
  type MemoryKind,
} from "./views/memory.js";

/** A spoken introduction longer than this is cut before it is read. */
export const MAX_INTRO_TRANSCRIPT = 4_000;
/** How many extra facts one introduction may yield. */
export const MAX_INTAKE_FACTS = 8;

/** One durable fact the introduction yielded beyond name and bio. */
export interface OnboardingFact {
  content: string;
  bucket: MemoryBucket;
  kind: MemoryKind;
  label: string | null;
}

/**
 * What the about step produces from a spoken (or typed) introduction. The
 * person edits name and about before they are written; `facts` are the
 * rest of what was said, each kept as its own memory.
 *
 * Structurally the `OnboardingIntake` of `@pistachio/shell-contracts/onboarding`,
 * which is the shape the IPC contract carries. It is restated rather than
 * imported because that package already depends on this one, and a link
 * back would be a cycle.
 */
export interface OnboardingIntake {
  transcript: string;
  name: string;
  about: string;
  facts: OnboardingFact[];
}

/** No model to listen with: this Mac could not reach control for a token, signed in or anonymous. */
export const NO_SPEECH_MODEL =
  "Voice isn't available right now: Pistachio's models couldn't be reached from this Mac. Type your introduction instead.";

/** How long a transcription may take before the wizard offers typing instead. */
const TRANSCRIBE_TIMEOUT_MS = 90_000;
/** How long the reader may take; the heuristic answers if it does not. */
const EXTRACT_TIMEOUT_MS = 45_000;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The caller's abort and this call's own deadline, as one signal. */
function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/* -------------------------------- speech --------------------------------- */

export interface TranscribeIntroductionOptions {
  /** The transcription endpoint's model, or null where there is none. */
  model: TranscriptionModel | null;
  /** A chat model that hears audio, for when the endpoint cannot be used. */
  fallbackModel?: LanguageModel | null;
  audio: Uint8Array;
  mediaType: string;
  signal?: AbortSignal;
}

/**
 * Speech to text. Rejects with NO_SPEECH_MODEL when nothing can listen, and
 * with what went wrong otherwise — both readable enough to show.
 */
export async function transcribeIntroduction(options: TranscribeIntroductionOptions): Promise<string> {
  const fallbackModel = options.fallbackModel ?? null;
  if (options.model === null && fallbackModel === null) throw new Error(NO_SPEECH_MODEL);
  const failures: string[] = [];
  if (options.model !== null) {
    try {
      const result = await transcribe({
        model: options.model,
        audio: options.audio,
        abortSignal: deadline(TRANSCRIBE_TIMEOUT_MS, options.signal),
      });
      const text = result.text.trim();
      if (text !== "") return text.slice(0, MAX_INTRO_TRANSCRIPT);
      failures.push("the transcription came back empty");
    } catch (error) {
      failures.push(message(error));
    }
  }
  // A chat model that takes audio, for when the transcription endpoint is
  // unavailable for the chosen model.
  if (fallbackModel !== null) {
    try {
      const { text } = await generateText({
        model: fallbackModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "file", data: options.audio, mediaType: options.mediaType },
              {
                type: "text",
                text: "Transcribe this recording word for word, in the speaker's language. Return only the transcript — no preamble, no quotes.",
              },
            ],
          },
        ],
        abortSignal: deadline(TRANSCRIBE_TIMEOUT_MS, options.signal),
      });
      const trimmed = text.trim();
      if (trimmed !== "") return trimmed.slice(0, MAX_INTRO_TRANSCRIPT);
      failures.push("the model returned nothing");
    } catch (error) {
      failures.push(message(error));
    }
  }
  throw new Error(`Couldn't transcribe the recording (${failures.join("; ")}). Type your introduction instead.`);
}

/* ------------------------------- the intake ------------------------------ */

/** Flat on purpose: one shape every provider's structured output can fill. */
export const INTAKE_SCHEMA = z.object({
  name: z.string().nullable().describe("The name they want to be called by, as they said it. Null if they gave none."),
  about: z
    .string()
    .nullable()
    .describe(
      "A two-to-three sentence bio in the third person, no name, from what they said: what they do, what they care about, how they like things done. Null if they said nothing about themselves.",
    ),
  facts: z
    .array(
      z.object({
        content: z.string().describe("One durable fact about the person, one line, as a plain statement about them."),
        bucket: z.enum(MEMORY_BUCKETS),
        kind: z.enum(MEMORY_KINDS).describe("static for a lasting trait, dynamic for current context."),
        label: z.string().nullable().describe("Only for a named thing: a place, a project, a person, an account. Null otherwise."),
      }),
    )
    .max(MAX_INTAKE_FACTS),
});

export function intakePrompt(transcript: string, now: Date): string {
  return `A person has just installed a browser with a built-in agent that works inside their signed-in tabs, and introduced themselves to it. Read the introduction and fill in what the agent should remember.

Today is ${now.toISOString().slice(0, 10)}.

The introduction:
"""
${transcript}
"""

- name: what they want to be called. Prefer a first name or nickname if they offered one.
- about: a short third-person bio from their own words — role, work, interests, how they like things done. Do not repeat the name. Null if there is nothing to say.
- facts: everything else durable and useful for doing tasks on their behalf — where they live or work (bucket location, with a label), projects (bucket project, with a label), tools and services they use (bucket account), routines (bucket routine), preferences (bucket preference), people they mention (bucket contact, with a label). One fact per item, at most ${String(MAX_INTAKE_FACTS)}, nothing already covered by name or about. Never record passwords, codes, or card or account numbers. When in doubt, leave it out.`;
}

export interface ExtractIntakeOptions {
  /** The reader, or null where no model can be reached: the heuristic answers. */
  model: LanguageModel | null;
  transcript: string;
  now?: Date;
  signal?: AbortSignal;
}

/**
 * Name, bio, and facts from an introduction. A model when one is given; the
 * heuristic otherwise, or when the model fails or returns nothing usable.
 * Never throws.
 */
export async function extractIntake(options: ExtractIntakeOptions): Promise<OnboardingIntake> {
  const fallback = heuristicIntake(options.transcript);
  if (fallback.transcript === "" || options.model === null) return fallback;
  try {
    const { object } = await generateObject({
      model: options.model,
      schema: INTAKE_SCHEMA,
      prompt: intakePrompt(fallback.transcript, options.now ?? new Date()),
      abortSignal: deadline(EXTRACT_TIMEOUT_MS, options.signal),
    });
    const intake = sanitizeOnboardingIntake({
      transcript: fallback.transcript,
      name: object.name ?? fallback.name,
      about: object.about ?? fallback.about,
      facts: object.facts.filter((fact) => !looksSensitive(fact.content)),
    });
    return intake.name === "" && intake.about === "" && intake.facts.length === 0 ? fallback : intake;
  } catch {
    return fallback;
  }
}

/* ------------------------------- sanitizing ------------------------------ */

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function prose(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

export function sanitizeOnboardingFacts(value: unknown): OnboardingFact[] {
  if (!Array.isArray(value)) return [];
  const out: OnboardingFact[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const content = line(item["content"], MAX_MEMORY_CONTENT);
    if (content === "" || seen.has(content.toLowerCase())) continue;
    seen.add(content.toLowerCase());
    const label = line(item["label"], MAX_MEMORY_LABEL);
    out.push({
      content,
      bucket: oneOf(item["bucket"], MEMORY_BUCKETS, "other"),
      kind: oneOf(item["kind"], MEMORY_KINDS, "static"),
      label: label === "" ? null : label,
    });
    if (out.length === MAX_INTAKE_FACTS) break;
  }
  return out;
}

export function sanitizeOnboardingIntake(value: unknown): OnboardingIntake {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    transcript: prose(raw["transcript"], MAX_INTRO_TRANSCRIPT),
    name: line(raw["name"], MAX_MEMORY_LABEL),
    about: prose(raw["about"], MAX_MEMORY_CONTENT),
    facts: sanitizeOnboardingFacts(raw["facts"]),
  };
}

/* -------------------------------- heuristics ----------------------------- */

/** A capitalised word or two: the name itself is never matched case-insensitively. */
const NAME = "([A-Z][a-zA-Z'-]+(?:\\s+[A-Z][a-zA-Z'-]+)?)";
const NAME_PATTERNS = [
  new RegExp(`\\b(?:[Mm]y name is|[Mm]y name's|[Ii] am called|[Ii]'m called|[Cc]all me|[Tt]his is|[Ii] go by)\\s+${NAME}`),
  new RegExp(`\\b(?:[Ii]'m|[Ii] am|[Ii]t's)\\s+${NAME}(?=[\\s,.!]|$)`),
];

const NOT_NAMES = new Set([
  "a", "an", "the", "not", "so", "very", "just", "here", "also", "really", "currently", "based", "from", "in", "at",
  "working", "looking", "trying", "going", "excited", "happy", "glad", "new", "pretty", "quite", "mostly", "still",
]);

/**
 * A name and bio read straight off the transcript, for when no model is
 * reachable: the first "my name is …" / "I'm …" the text offers, and the
 * introduction itself as the bio. Good enough to prefill fields the person
 * is about to edit; never used to write a fact without them seeing it.
 */
export function heuristicIntake(transcript: string): OnboardingIntake {
  const text = prose(transcript, MAX_INTRO_TRANSCRIPT);
  let name = "";
  for (const pattern of NAME_PATTERNS) {
    const match = pattern.exec(text);
    const candidate = match?.[1]?.trim() ?? "";
    const first = candidate.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (candidate !== "" && !NOT_NAMES.has(first)) {
      name = candidate;
      break;
    }
  }
  return { transcript: text, name: line(name, MAX_MEMORY_LABEL), about: aboutFrom(text), facts: [] };
}

/** The introduction as a bio: greetings and "my name is" dropped, first person kept. */
function aboutFrom(text: string): string {
  const cleaned = text
    .replace(/^(?:hi|hey|hello|hi there|hey there)[,!.]?\s*/i, "")
    .replace(/\b(?:[Mm]y name is|[Mm]y name's|[Cc]all me|[Ii] go by)\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?[,.]?\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return prose(sentence, MAX_MEMORY_CONTENT);
}
