/**
 * The thread's model context, and how it is kept within budget.
 *
 * A thread's history is a real `ModelMessage[]` — user turns, assistant
 * turns with their tool calls, and tool results — the same shape the SDK
 * hands back after a step, so every turn continues exactly where the last
 * one left off. Left alone that history grows without bound: one page
 * inspection is a few thousand tokens, and a long task takes hundreds of
 * steps. Two mechanisms keep it bounded, both pure over the message array:
 *
 *  1. Trimming — deterministic and cheap. Bulky tool outputs older than the
 *     last few steps are replaced with a short stub (the page is still in
 *     the browser; the agent can inspect it again). Attachments the person
 *     sent earlier are elided the same way.
 *  2. Compaction — model-assisted. When the context still nears the budget,
 *     everything between the task statement and the most recent steps is
 *     folded into one written summary. The agent's notes (run-controller,
 *     `task_notes`) survive independently: they are in the system prompt,
 *     not the history.
 *
 * Nothing here calls a model; the runner supplies the summary.
 */

import type { AssistantModelMessage, ModelMessage, ToolModelMessage, ToolResultPart, UserModelMessage } from "ai";

/* ------------------------------- budget ---------------------------------- */

export interface ContextBudget {
  /** The model's context window, in tokens. */
  window: number;
  /** The context size at which older history is compacted. */
  compactAt: number;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** `PISTACHIO_AGENT_CONTEXT_TOKENS` sets the window; `PISTACHIO_AGENT_COMPACT_AT` the threshold (default half the window). */
export function contextBudget(env: NodeJS.ProcessEnv = process.env): ContextBudget {
  const window = positive(env["PISTACHIO_AGENT_CONTEXT_TOKENS"]) ?? DEFAULT_CONTEXT_WINDOW;
  const compactAt = positive(env["PISTACHIO_AGENT_COMPACT_AT"]) ?? Math.floor(window / 2);
  return { window, compactAt: Math.min(compactAt, window) };
}

function positive(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/* ------------------------------ estimates -------------------------------- */

/** Tokens a file part is assumed to cost — an image tile budget, roughly. */
const FILE_PART_TOKENS = 1_600;
const PART_OVERHEAD = 8;

function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function jsonTokens(value: unknown): number {
  try {
    return textTokens(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

/** A rough token count for what a message array costs as model input. */
export function estimateTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += PART_OVERHEAD;
    if (typeof message.content === "string") {
      total += textTokens(message.content);
      continue;
    }
    for (const part of message.content) {
      total += PART_OVERHEAD;
      switch (part.type) {
        case "text":
        case "reasoning":
          total += textTokens(part.text);
          break;
        case "file":
        case "image":
          total += FILE_PART_TOKENS;
          break;
        case "tool-call":
          total += jsonTokens(part.input) + textTokens(part.toolName);
          break;
        case "tool-result":
          if (part.output.type === "content") {
            for (const item of part.output.value) total += item.type === "text" ? textTokens(item.text) : FILE_PART_TOKENS;
          } else total += jsonTokens(part.output);
          break;
        default:
          total += jsonTokens(part);
      }
    }
  }
  return total;
}

/* ------------------------------- trimming -------------------------------- */

/** How many of the most recent tool results keep their full output. */
export const KEEP_FULL_TOOL_RESULTS = 3;
/** Older tool outputs longer than this are stubbed. */
export const MAX_KEPT_OUTPUT_CHARS = 1_200;
const ELIDED = "__elided";

export function isElided(output: ToolResultPart["output"]): boolean {
  return (
    output.type === "json" &&
    typeof output.value === "object" &&
    output.value !== null &&
    !Array.isArray(output.value) &&
    (output.value as Record<string, unknown>)[ELIDED] === true
  );
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function pick(value: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof value !== "object" || value === null) return out;
  const record = value as Record<string, unknown>;
  const data = typeof record["data"] === "object" && record["data"] !== null ? (record["data"] as Record<string, unknown>) : record;
  for (const key of keys) {
    const found = data[key] ?? record[key];
    if (typeof found === "string" || typeof found === "number" || typeof found === "boolean") out[key] = found;
  }
  return out;
}

/**
 * The stub an old tool output becomes. Page inspections keep their title
 * and address so the agent knows what it looked at; everything else keeps
 * a short preview.
 */
export function elideOutput(toolName: string, output: ToolResultPart["output"]): ToolResultPart["output"] {
  if (isElided(output)) return output;
  const serialized = output.type === "text" || output.type === "error-text" ? output.value : stringify("value" in output ? output.value : output);
  if (toolName === "page_inspect") {
    return {
      type: "json",
      value: {
        ...pick(output.type === "json" ? output.value : null, ["title", "url", "summary"]),
        note: "Page text and controls elided from context. Call page_inspect again for the current view.",
        [ELIDED]: true,
      },
    };
  }
  if (toolName === "page_screenshot") {
    return { type: "json", value: { note: "Screenshot elided from context. Call page_screenshot again if you need the picture.", [ELIDED]: true } };
  }
  if (serialized.length <= MAX_KEPT_OUTPUT_CHARS) return output;
  const preview = serialized.slice(0, Math.floor(MAX_KEPT_OUTPUT_CHARS / 2)).trimEnd();
  return {
    type: "json",
    value: {
      ...pick(output.type === "json" ? output.value : null, ["summary", "ok", "title", "url", "tabId", "id"]),
      preview: `${preview}…`,
      note: `Output elided from context (${String(serialized.length)} characters). Repeat the call if you need it.`,
      [ELIDED]: true,
    },
  };
}

const ATTACHMENT_STUB = "[attachment omitted from context";

/**
 * Bound the history: every tool result but the last `keepLast` becomes a
 * stub — counted per result, not per message, since one step can read
 * several pages at once — and attachments in every user message but the
 * most recent one that has any become a line naming the file.
 */
export function trimHistory(messages: ModelMessage[], keepLast = KEEP_FULL_TOOL_RESULTS): ModelMessage[] {
  // The newest tool message stays whole no matter how many results it
  // holds: the model has not read them yet. Before it, the last `keepLast`
  // results stay whole and the rest become stubs.
  const keep = new Set<string>();
  const newest = messages.reduce<number>((found, message, index) => (message.role === "tool" ? index : found), -1);
  let remaining = keepLast;
  if (newest >= 0) {
    const parts = (messages[newest] as ToolModelMessage).content;
    for (let part = 0; part < parts.length; part += 1) keep.add(`${String(newest)}:${String(part)}`);
    remaining = Math.max(0, keepLast - parts.filter((part) => part.type === "tool-result").length);
  }
  for (let index = newest - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "tool") continue;
    for (let part = message.content.length - 1; part >= 0 && remaining > 0; part -= 1) {
      if (message.content[part]!.type !== "tool-result") continue;
      keep.add(`${String(index)}:${String(part)}`);
      remaining -= 1;
    }
  }
  const lastWithFiles = messages.reduce<number>((found, message, index) => (hasFiles(message) ? index : found), -1);
  return messages.map((message, index) => {
    if (message.role === "tool") return trimToolMessage(message, (part) => keep.has(`${String(index)}:${String(part)}`));
    if (message.role === "user" && index !== lastWithFiles && hasFiles(message)) return stripFiles(message);
    return message;
  });
}

function hasFiles(message: ModelMessage): boolean {
  return message.role === "user" && typeof message.content !== "string" && message.content.some((part) => part.type === "file" || part.type === "image");
}

function stripFiles(message: UserModelMessage): UserModelMessage {
  if (typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type === "file") return { type: "text" as const, text: `${ATTACHMENT_STUB}: ${part.filename ?? part.mediaType}]` };
      if (part.type === "image") return { type: "text" as const, text: `${ATTACHMENT_STUB}: ${part.mediaType ?? "image"}]` };
      return part;
    }),
  };
}

function trimToolMessage(message: ToolModelMessage, kept: (part: number) => boolean): ToolModelMessage {
  let changed = false;
  const content = message.content.map((part, index) => {
    if (part.type !== "tool-result" || kept(index)) return part;
    const output = elideOutput(part.toolName, part.output);
    if (output === part.output) return part;
    changed = true;
    return { ...part, output };
  });
  return changed ? { ...message, content } : message;
}

/* --------------------------- dangling tool calls ------------------------- */

/**
 * Every tool call the assistant made must be answered before the next
 * model call, or the provider rejects the prompt. A turn cut short — the
 * person interrupted, the app quit — can leave calls without results;
 * this answers them with the reason.
 */
export function closeDanglingToolCalls(messages: ModelMessage[], reason: string): ModelMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  const out: ModelMessage[] = [];
  for (const message of messages) {
    out.push(message);
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    const open = message.content.filter(
      (part): part is Extract<typeof part, { type: "tool-call" }> => part.type === "tool-call" && !part.providerExecuted && !answered.has(part.toolCallId),
    );
    if (open.length === 0) continue;
    out.push({
      role: "tool",
      content: open.map((part) => ({
        type: "tool-result" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: { type: "error-text" as const, value: reason },
      })),
    });
    for (const part of open) answered.add(part.toolCallId);
  }
  return out;
}

/* ------------------------------ compaction ------------------------------- */

/** How many of the most recent messages stay verbatim through a compaction. */
export const COMPACTION_TAIL = 6;
export const SUMMARY_HEADER = "[Context summary — earlier work in this thread was compacted. What follows is a faithful summary of it.]";

/**
 * Split the history for compaction: the tail — the last few messages,
 * never starting on a tool result — stays verbatim; the head is what gets
 * summarised. The first message (the task itself) is never in either; it
 * is kept as the anchor the summary attaches to. Returns null when there
 * is too little between the task and the tail to be worth summarising.
 */
export function splitForCompaction(messages: ModelMessage[], keepTail = COMPACTION_TAIL): { anchor: ModelMessage; head: ModelMessage[]; tail: ModelMessage[] } | null {
  if (messages.length < keepTail + 3) return null;
  const anchor = messages[0]!;
  let start = Math.max(1, messages.length - keepTail);
  while (start > 1 && messages[start]!.role === "tool") start -= 1;
  const head = messages.slice(1, start);
  if (head.length < 2) return null;
  return { anchor, head, tail: messages.slice(start) };
}

const RENDER_TEXT_MAX = 600;
const RENDER_INPUT_MAX = 300;
const RENDER_OUTPUT_MAX = 800;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The head as a transcript for the summarising model. */
export function renderForSummary(messages: ModelMessage[], maxChars = 60_000): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      lines.push(`${message.role.toUpperCase()}: ${clip(message.content, RENDER_TEXT_MAX * 2)}`);
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const value =
          part.output.type === "text" || part.output.type === "error-text"
            ? part.output.value
            : part.output.type === "content"
              ? part.output.value.map((item) => (item.type === "text" ? item.text : `[${item.type}]`)).join(" ")
              : stringify("value" in part.output ? part.output.value : part.output);
        lines.push(`TOOL ${part.toolName}${part.output.type.startsWith("error") ? " (failed)" : ""} → ${clip(value, RENDER_OUTPUT_MAX)}`);
      }
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (part.text.trim() !== "") lines.push(`${message.role.toUpperCase()}: ${clip(part.text, RENDER_TEXT_MAX * 2)}`);
          break;
        case "tool-call":
          lines.push(`ASSISTANT → ${part.toolName}(${clip(stringify(part.input), RENDER_INPUT_MAX)})`);
          break;
        case "file":
          lines.push(`USER attached: ${part.filename ?? part.mediaType}`);
          break;
        case "image":
          lines.push("USER attached: image");
          break;
        default:
          break;
      }
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `…[earlier part omitted]\n${text.slice(-maxChars)}`;
  return text;
}

export function compactionPrompt(transcript: string, notes: string): string {
  return `You are compacting the working context of a browser-operating agent in the middle of a long task. The transcript below is the part of its history that is about to be removed from context; it begins with the task itself and, when the context was compacted before, the summary written then — everything in that earlier summary that still matters must survive into yours. The agent keeps only your summary, its notes, and its most recent steps. Write the summary the agent needs to continue without losing anything that matters.

Include, as plain text with short headings:
- Task: what the person asked for and any clarifications or constraints they gave later.
- Progress: what has been done and verified so far, in order.
- Facts and identifiers to keep: tab ids, URLs, names, values, ids of memories/reminders/artifacts/bookmarks created, prices, dates, anything the agent looked up that it will need again.
- Problems: what failed or was blocked, and what was tried.
- Remaining work: concrete next steps.

Be precise and dense; prefer lists to prose. Never invent details. Do not include instructions to the agent beyond the remaining work.${notes.trim() === "" ? "" : `

The agent's own notes (already kept separately — do not repeat what they already say, but keep anything they miss):
${notes.trim()}`}

Transcript to compact:
${transcript}`;
}

function firstText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");
}

/**
 * Replace the head with the summary, attached to the anchor (the task
 * message) so the model always reads the task and what has happened since
 * as one turn. A summary left by an earlier compaction is superseded.
 */
export function applyCompaction(split: { anchor: ModelMessage; tail: ModelMessage[] }, summary: string): ModelMessage[] {
  const anchor = split.anchor;
  const summaryPart = { type: "text" as const, text: `${SUMMARY_HEADER}\n\n${summary.trim()}` };
  const base: UserModelMessage =
    anchor.role === "user"
      ? anchor
      : { role: "user", content: [{ type: "text", text: `[Earlier context]\n${firstText(anchor)}` }] };
  const parts = typeof base.content === "string" ? [{ type: "text" as const, text: base.content }] : base.content;
  const kept = parts.filter((part) => !(part.type === "text" && part.text.startsWith(SUMMARY_HEADER)));
  const merged: UserModelMessage = { ...base, content: [...kept, summaryPart] };
  return [merged, ...split.tail];
}

/* ------------------------------- building -------------------------------- */

/** A user turn as a model message: the text, with any attachments as file parts. */
export function userMessage(text: string, attachments: Array<{ name: string; mediaType: string; url: string }> = []): UserModelMessage {
  if (attachments.length === 0) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...attachments.map((file) => ({ type: "file" as const, data: file.url, mediaType: file.mediaType, filename: file.name })),
    ],
  };
}

/** The assistant's text in a message, for transcripts and titles. */
export function assistantText(message: AssistantModelMessage): string {
  return firstText(message);
}

/** How many tool calls a message array carries — the trace's count when a thread is reopened. */
export function countToolCalls(messages: ModelMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) if (part.type === "tool-call") count += 1;
  }
  return count;
}
