/**
 * The model-backed half of memory: the embedder that gives search its
 * semantic score, and the learner that reads a finished conversation for
 * facts worth keeping.
 *
 * Both are best-effort. No key, a provider outage, a model that returns
 * nonsense — search falls back to lexical and the run's record simply
 * gains no memories. Neither can fail a run.
 *
 * The learner is supermemory's extraction step in miniature: it sees what
 * is already known (with ids), the conversation, and returns ADD / UPDATE /
 * FORGET operations. An `update` is a new version of an existing fact; an
 * `add` the learner is not sure of lands PENDING, down-weighted in search
 * and queued for the person to confirm on the settings page.
 */

import { embedMany, generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import {
  activeMemories,
  looksSensitive,
  MEMORY_BUCKETS,
  MEMORY_KINDS,
  memoryWeight,
  sanitizeMemoryOperations,
  type MemoryEntry,
  type MemoryOperation,
} from "@pistachio/shell-contracts/memory";
import type { MemoryChangeSet, MemoryEmbedder, MemoryStore } from "./memory-store";
import {
  configuredEmbeddingModel,
  configuredModel,
  embeddingModelName,
  loadWorkspaceEnvironment,
} from "./model-provider";

/** Below this, a learned fact waits for the person to confirm it. */
export const LEARNED_REVIEW_THRESHOLD = 0.75;
const MAX_KNOWN = 80;
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_OPERATIONS = 12;

/** Null when vectors are off, unconfigured, or this is a test run. */
export function createMemoryEmbedder(): MemoryEmbedder | null {
  if (process.env["PISTACHIO_E2E"] === "1" && process.env["PISTACHIO_AGENT_LIVE"] !== "1") return null;
  loadWorkspaceEnvironment();
  const id = embeddingModelName();
  if (id === null) return null;
  // The model is resolved per call, so a key added in Settings takes effect
  // without a restart. The id is the model's name, which no key changes.
  return {
    id,
    embed: async (values) => {
      const configured = configuredEmbeddingModel();
      if (configured === null) throw new Error("No AI provider is configured for memory embeddings.");
      return (await embedMany({ model: configured.model, values })).embeddings;
    },
  };
}

export { looksSensitive };

/**
 * Turn the learner's raw answer into operations the store will take:
 * sanitized, secrets dropped up front (the store refuses them too, but a
 * refusal here keeps the batch's slot count for facts that will land),
 * unsure additions marked pending.
 */
export function learnedOperations(raw: unknown): MemoryOperation[] {
  return sanitizeMemoryOperations(raw)
    .filter((operation) => operation.op === "forget" || operation.content === undefined || !looksSensitive(operation.content))
    .slice(0, MAX_OPERATIONS)
    .map((operation) => {
      if (operation.op !== "add") return operation;
      const confidence = operation.confidence ?? 0.7;
      return { ...operation, confidence, review: confidence >= LEARNED_REVIEW_THRESHOLD ? "approved" : "pending" };
    });
}

/** Flat on purpose: one shape every provider's structured output can fill. */
const LEARNED_SCHEMA = z.object({
  operations: z
    .array(
      z.object({
        op: z.enum(["add", "update", "forget"]),
        content: z.string().nullable().describe("The fact, one line, entity-centric. Required for add and update."),
        id: z.string().nullable().describe("An existing memory id. Required for update and forget."),
        kind: z.enum(MEMORY_KINDS).nullable().describe("static for a lasting trait, dynamic for current context."),
        bucket: z.enum(MEMORY_BUCKETS).nullable(),
        label: z
          .string()
          .nullable()
          .describe("Only for a named thing the fact is about — a place, a project, a person, an account. Null for traits and preferences."),
        key: z
          .string()
          .nullable()
          .describe("A profile slot: profile.name, profile.about, profile.timezone. Null for everything else."),
        confidence: z.number().min(0).max(1).nullable().describe("How sure you are the person meant this as a fact about themselves."),
        forgetAfter: z.string().nullable().describe("ISO date after which the fact stops being true, or null."),
        reason: z.string().nullable().describe("For forget: why."),
      }),
    )
    .max(MAX_OPERATIONS),
});

export interface LearnInput {
  runId: string;
  purpose: string;
  conversation: Array<{ role: "user" | "assistant" | "system"; content: string }>;
}

function known(entries: MemoryEntry[], now: Date): string {
  const active = activeMemories(entries, now)
    .sort((a, b) => memoryWeight(b, now) - memoryWeight(a, now))
    .slice(0, MAX_KNOWN);
  if (active.length === 0) return "(nothing yet)";
  return active
    .map((entry) => {
      const label = entry.label === null ? "" : ` label=${JSON.stringify(entry.label)}`;
      const key = entry.key === null ? "" : ` key=${entry.key}`;
      return `[${entry.id}] (${entry.kind}, ${entry.bucket}${label}${key}) ${JSON.stringify(entry.content)}`;
    })
    .join("\n");
}

function transcript(conversation: LearnInput["conversation"]): string {
  const lines = conversation
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`);
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) text = `…${text.slice(-MAX_TRANSCRIPT_CHARS)}`;
  return text;
}

function learnerPrompt(entries: MemoryEntry[], input: LearnInput, now: Date): string {
  return `You maintain long-term memory about one person for a browser agent that works in their signed-in browser. Read the finished conversation and decide what, if anything, is worth remembering about the PERSON for future tasks.

Today is ${now.toISOString().slice(0, 10)}.

What is already remembered (id, kind, bucket, fact):
${known(entries, now)}

The conversation (task: ${input.purpose}):
${transcript(input.conversation)}

Return operations:
- add: a new durable fact about the person — who they are, what they prefer, where things are, who they deal with, what they are working on, what they asked to be remembered. One fact per operation, written as a plain statement about them ("Prefers aisle seats on flights"), no more than ${String(MAX_OPERATIONS)} in total. kind is "static" for lasting traits and "dynamic" for current context; pick the closest bucket; set forgetAfter when the fact has an end date.
- update: an existing fact that the conversation shows has changed — give its id and the new content. Prefer update over add when a fact supersedes one already remembered.
- forget: an existing fact the person said is no longer true or asked to forget — give its id and a reason.

Labels and slots:
- A label is a handle for a named thing the fact is about (a place: "Home"; a project: "Northstar"; a person: "Priya"; an account: "Corporate Amex"). The content must read on its own and must not repeat the label. Traits and preferences get no label.
- The person's name goes in key profile.name with the name alone as content; a self-description in profile.about; their time zone in profile.timezone as an IANA zone name. Writing a key that exists updates it.
- A place lives in bucket location with a label; a project in bucket project with a label.

Do not remember: the task's step-by-step actions, page contents, prices or listings the person did not ask to keep, anything already remembered unchanged, small talk, and never passwords, codes, card or account numbers. When in doubt, leave it out or lower the confidence. Return an empty list when nothing qualifies.`;
}

/**
 * Read a finished conversation and fold what it taught into the store.
 * Resolves with what changed; resolves with nothing on any failure.
 */
export async function learnFromConversation(
  store: MemoryStore,
  input: LearnInput,
  options: { model?: LanguageModel; now?: Date } = {},
): Promise<MemoryChangeSet> {
  const empty: MemoryChangeSet = { added: [], updated: [], forgotten: [] };
  if (!input.conversation.some((message) => message.role === "user" && message.content.trim() !== "")) return empty;
  const now = options.now ?? new Date();
  try {
    const model = options.model ?? configuredModel();
    const { object } = await generateObject({
      model,
      schema: LEARNED_SCHEMA,
      prompt: learnerPrompt(store.all(), input, now),
    });
    const operations = learnedOperations(object.operations);
    if (operations.length === 0) return empty;
    return store.applyOperations(operations, { kind: "learned", runId: input.runId });
  } catch {
    return empty;
  }
}

export function describeChanges(changes: MemoryChangeSet): string {
  const parts: string[] = [];
  const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
  if (changes.added.length > 0) parts.push(`${count(changes.added.length, "new fact")}`);
  if (changes.updated.length > 0) parts.push(`${count(changes.updated.length, "fact")} updated`);
  if (changes.forgotten.length > 0) parts.push(`${count(changes.forgotten.length, "fact")} forgotten`);
  const pending = changes.added.filter((entry) => entry.review === "pending").length;
  const summary = parts.join(", ");
  return pending === 0 ? summary : `${summary} · ${String(pending)} waiting for your review`;
}
