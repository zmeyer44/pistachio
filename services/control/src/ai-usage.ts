/**
 * The per-user model meter behind `/v1/ai/*` (ai-proxy.ts).
 *
 * Every proxied request spends the operator's gateway key on one account's
 * behalf, so every one of them leaves a row in `ai_usage`: who, which
 * device, what kind of model, which model, how it ended, and what it cost —
 * tokens and the gateway's own USD figure when the answer carried them,
 * bytes and time always. The tokens and cost are read off the response as
 * it streams past (`meteredBody`), so a language-model stream reaches the
 * desktop unchanged and the row is written once it has finished.
 *
 * The reading is defensive on purpose: the AI SDK's wire shape has moved
 * between specification versions (flat `usage.inputTokens` numbers, then
 * `{total, ...}` objects) and the proxy forwards whichever the desktop
 * asked for. An answer whose usage cannot be read still counts as a
 * request; it just carries null tokens.
 *
 * `aiUsageSummary` is what a device reads back (`GET /v1/ai-usage`): the
 * account's totals for today and this month, UTC, and the month by model,
 * with the account's own monthly cap beside them. The cap is the one
 * control the account has over its spend (`PUT /v1/ai-usage/cap`): once
 * the month's cost reaches it the proxy refuses (`aiBudgetGuard`) until the
 * month turns or the cap moves.
 */

import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { accountLinks, aiBudgets, aiUsage } from "./db/schema.js";

export const AI_USAGE_KINDS = [
  "language-model",
  "embedding-model",
  // The address bar's intent model (docs/smart-suggestions.md): the SDK's
  // `experimental_evaluate` posts to `/evaluation-model`, and its answer is
  // a plain JSON body with the same `usage` and gateway `cost` every other
  // kind carries, so it meters through `meteredBody` unchanged.
  "evaluation-model",
  "speech-model",
  "transcription-model",
  "image-model",
  "reranking-model",
  "video-model",
  "other",
] as const;
export type AiUsageKind = (typeof AI_USAGE_KINDS)[number];

/** Rows older than this are pruned by the hourly maintenance job. */
export const AI_USAGE_RETENTION_DAYS = 90;

/**
 * How much of a non-streaming answer is kept in memory for the usage read.
 * A language-model JSON answer is well under this; anything larger (an
 * image, a video job) is counted by bytes alone.
 */
export const AI_USAGE_CAPTURE_LIMIT_BYTES = 8 * 1024 * 1024;

/** The model kind from the proxied path: `/v1/ai/<kind>[/...]`. */
export function usageKindOf(pathname: string, prefix: string): AiUsageKind {
  const rest = pathname.startsWith(`${prefix}/`)
    ? pathname.slice(prefix.length + 1)
    : "";
  const first = rest.split("/")[0] ?? "";
  return (AI_USAGE_KINDS as readonly string[]).includes(first)
    ? (first as AiUsageKind)
    : "other";
}

export interface ExtractedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** The gateway's USD figure as a decimal string, or null when it sent none. */
  costUsd: string | null;
}

export const NO_USAGE: ExtractedUsage = {
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
};

function count(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  if (typeof value === "object" && value !== null && "total" in value)
    return count((value as { total: unknown }).total);
  return null;
}

function cost(value: unknown): string | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  // numeric(14, 8): a fixed string keeps the insert exact and the sums honest.
  return parsed.toFixed(8);
}

/** Tokens and cost from one SDK answer (a JSON body, or a stream's finish part). */
export function usageFromPart(part: unknown): ExtractedUsage {
  if (typeof part !== "object" || part === null) return NO_USAGE;
  const record = part as Record<string, unknown>;
  const usage =
    typeof record["usage"] === "object" && record["usage"] !== null
      ? (record["usage"] as Record<string, unknown>)
      : {};
  const metadata = record["providerMetadata"];
  const gateway =
    typeof metadata === "object" &&
    metadata !== null &&
    typeof (metadata as Record<string, unknown>)["gateway"] === "object"
      ? ((metadata as Record<string, unknown>)["gateway"] as Record<
          string,
          unknown
        > | null)
      : null;
  return {
    // Embeddings report `usage.tokens`: input only.
    inputTokens: count(usage["inputTokens"]) ?? count(usage["tokens"]),
    outputTokens: count(usage["outputTokens"]),
    costUsd: gateway === null ? null : cost(gateway["cost"]),
  };
}

export function usageFromJson(text: string): ExtractedUsage {
  try {
    return usageFromPart(JSON.parse(text));
  } catch {
    return NO_USAGE;
  }
}

/**
 * The finish part of an SSE stream carries the usage; every other part is
 * skipped without being parsed further than its `type`.
 */
class EventStreamReader {
  #pending = "";
  #found: ExtractedUsage | null = null;

  push(text: string): void {
    this.#pending += text;
    let newline = this.#pending.indexOf("\n");
    while (newline !== -1) {
      this.#line(this.#pending.slice(0, newline));
      this.#pending = this.#pending.slice(newline + 1);
      newline = this.#pending.indexOf("\n");
    }
  }

  finish(): ExtractedUsage {
    if (this.#pending !== "") this.#line(this.#pending);
    this.#pending = "";
    return this.#found ?? NO_USAGE;
  }

  #line(raw: string): void {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]" || !payload.includes('"finish"'))
      return;
    try {
      const part = JSON.parse(payload) as { type?: unknown };
      if (part.type === "finish") this.#found = usageFromPart(part);
    } catch {
      // A partial or non-JSON data line: not the finish part.
    }
  }
}

export function usageFromEventStream(text: string): ExtractedUsage {
  const reader = new EventStreamReader();
  reader.push(text);
  return reader.finish();
}

export interface MeteredOutcome {
  responseBytes: number;
  usage: ExtractedUsage;
  /** The stream ended before the upstream did: the desktop went away, or the upstream failed mid-way. */
  truncated: boolean;
}

/**
 * The upstream body, passed through byte for byte, with the usage read on
 * the side. `onDone` fires exactly once, when the body ends however it
 * ends. A null body (204, HEAD) reports at once.
 */
export function meteredBody(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  onDone: (outcome: MeteredOutcome) => void,
  captureLimit: number = AI_USAGE_CAPTURE_LIMIT_BYTES,
): ReadableStream<Uint8Array> | null {
  if (body === null) {
    onDone({ responseBytes: 0, usage: NO_USAGE, truncated: false });
    return null;
  }
  const streaming = (contentType ?? "")
    .toLowerCase()
    .includes("text/event-stream");
  const json = (contentType ?? "").toLowerCase().includes("application/json");
  const decoder = new TextDecoder();
  const events = streaming ? new EventStreamReader() : null;
  let captured = "";
  let overflow = false;
  let bytes = 0;
  let reported = false;
  const report = (truncated: boolean): void => {
    if (reported) return;
    reported = true;
    let usage = NO_USAGE;
    if (events !== null) usage = events.finish();
    else if (json && !overflow)
      usage = usageFromJson(captured + decoder.decode());
    onDone({ responseBytes: bytes, usage, truncated });
  };
  // `cancel` is part of the transformer contract (it fires when the reader
  // goes away) but not yet of TypeScript's lib typing for it.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(): void } =
    {
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (events !== null)
          events.push(decoder.decode(chunk, { stream: true }));
        else if (json && !overflow) {
          if (bytes > captureLimit) {
            overflow = true;
            captured = "";
          } else captured += decoder.decode(chunk, { stream: true });
        }
        controller.enqueue(chunk);
      },
      flush() {
        report(false);
      },
      cancel() {
        report(true);
      },
    };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>(transformer),
  );
}

/* --------------------------------- rows ---------------------------------- */

export interface AiUsageSample {
  userId: string;
  deviceId: string;
  kind: AiUsageKind;
  modelId: string | null;
  /** The upstream status, or 0 when the gateway could not be reached. */
  status: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  at: Date;
}

/**
 * One meter row. The answer it measures ended some time after the request
 * was admitted, and in between an anonymous account may have been folded
 * into a real one (`POST /account/link`) — its user row is gone, and the
 * insert fails on the foreign key. The spend is still the person's: the row
 * goes to the account `account_links` says the anonymous one became, so it
 * counts toward that account's meter and cap.
 */
export async function recordAiUsage(
  db: Db,
  sample: AiUsageSample,
): Promise<void> {
  try {
    await db.insert(aiUsage).values(sample);
  } catch (error) {
    const [link] = await db
      .select({ toUserId: accountLinks.toUserId })
      .from(accountLinks)
      .where(eq(accountLinks.fromUserId, sample.userId));
    // Not a folded-in account: whatever refused the row still stands.
    if (link === undefined) throw error;
    await db.insert(aiUsage).values({ ...sample, userId: link.toUserId });
  }
}

/* ------------------------------- summaries -------------------------------- */

export interface AiUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, as a decimal string; "0" when nothing carried a cost. */
  costUsd: string;
}

export interface AiUsageModelTotals extends AiUsageTotals {
  kind: AiUsageKind;
  modelId: string | null;
}

export interface AiUsageCap {
  /** USD per calendar month (UTC), as a decimal string; null is no cap. */
  monthlyUsd: string | null;
  /** The month's cost has reached the cap: `/v1/ai/*` is refusing. */
  reached: boolean;
}

export interface AiUsageSummary {
  /** Since 00:00 UTC today. */
  day: AiUsageTotals;
  /** Since the first of the month, UTC. */
  month: AiUsageTotals;
  /** The month, by model, most requests first. */
  models: AiUsageModelTotals[];
  since: { day: string; month: string };
  cap: AiUsageCap;
}

function startOfUtcDay(at: number): Date {
  const date = new Date(at);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function startOfUtcMonth(at: number): Date {
  const date = new Date(at);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function totalsOf(
  row:
    | {
        requests: unknown;
        inputTokens: unknown;
        outputTokens: unknown;
        costUsd: unknown;
      }
    | undefined,
): AiUsageTotals {
  return {
    requests: Number(row?.requests ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    costUsd: normalizeCost(row?.costUsd),
  };
}

/** Postgres hands numeric back as text; "0.00000000" reads as "0". */
function normalizeCost(value: unknown): string {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return "0";
  return parsed.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

/** The largest cap accepted: a guard against a typo, not a plan limit. */
export const MAX_MONTHLY_CAP_USD = 1_000_000;

/** A cap from the wire: a non-negative decimal (string or number) up to the maximum, or null. Undefined when unreadable. */
export function parseMonthlyCap(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_MONTHLY_CAP_USD)
    return undefined;
  return parsed.toFixed(8);
}

export async function aiMonthlyCap(
  db: Db,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ cap: aiBudgets.monthlyCapUsd })
    .from(aiBudgets)
    .where(eq(aiBudgets.userId, userId));
  return row?.cap == null ? null : normalizeCost(row.cap);
}

export async function setAiMonthlyCap(
  db: Db,
  userId: string,
  monthlyCapUsd: string | null,
  at: number,
): Promise<void> {
  await db
    .insert(aiBudgets)
    .values({ userId, monthlyCapUsd, updatedAt: new Date(at) })
    .onConflictDoUpdate({
      target: aiBudgets.userId,
      set: { monthlyCapUsd, updatedAt: new Date(at) },
    });
}

async function monthCostUsd(
  db: Db,
  userId: string,
  at: number,
): Promise<number> {
  const [row] = await db
    .select({ costUsd: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` })
    .from(aiUsage)
    .where(
      and(eq(aiUsage.userId, userId), gte(aiUsage.at, startOfUtcMonth(at))),
    );
  return Number(row?.costUsd ?? 0);
}

/** True once the month's cost has reached the account's cap; false with no cap. */
export async function aiCapReached(
  db: Db,
  userId: string,
  at: number,
): Promise<boolean> {
  const cap = await aiMonthlyCap(db, userId);
  if (cap === null) return false;
  const limit = Number(cap);
  // A cap of zero is "nothing at all", reached before the first call.
  return limit <= 0 || (await monthCostUsd(db, userId, at)) >= limit;
}

/**
 * True once the month's cost has reached an allowance the account does not
 * own and cannot raise — an anonymous account's (src/anonymous.ts).
 */
export async function aiAllowanceReached(
  db: Db,
  userId: string,
  at: number,
  allowanceUsd: number,
): Promise<boolean> {
  return allowanceUsd <= 0 || (await monthCostUsd(db, userId, at)) >= allowanceUsd;
}

/**
 * What `/v1/ai/*` answers when the cap is reached. Shaped as the gateway
 * shapes a refusal, so the desktop's SDK turns it into an error whose
 * message says what happened, and marked with control's own reason.
 */
export const AI_BUDGET_EXCEEDED = {
  error: {
    type: "forbidden",
    message:
      "This account's monthly model spend cap has been reached. Raise or remove the cap under Settings → Plan & billing, or wait for the month to turn.",
  },
  reason: "ai_budget_exceeded",
} as const;

/**
 * `allowanceUsd` is an anonymous account's monthly allowance: it is reported
 * as the cap, since it is the ceiling that account actually meets.
 */
export async function aiUsageSummary(
  db: Db,
  userId: string,
  at: number,
  allowanceUsd?: number,
): Promise<AiUsageSummary> {
  const day = startOfUtcDay(at);
  const month = startOfUtcMonth(at);
  const columns = {
    requests: sql<string>`count(*)`,
    inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
    outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
    costUsd: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)`,
  };
  const [dayRows, monthRows, modelRows, cap] = await Promise.all([
    db
      .select(columns)
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), gte(aiUsage.at, day))),
    db
      .select(columns)
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), gte(aiUsage.at, month))),
    db
      .select({ ...columns, kind: aiUsage.kind, modelId: aiUsage.modelId })
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), gte(aiUsage.at, month)))
      .groupBy(aiUsage.kind, aiUsage.modelId)
      // Most requests first, then most tokens; the names break the ties so
      // the order is the same every read.
      .orderBy(
        desc(sql`count(*)`),
        desc(sql`coalesce(sum(${aiUsage.inputTokens}), 0)`),
        asc(aiUsage.kind),
        asc(aiUsage.modelId),
      )
      .limit(50),
    allowanceUsd === undefined
      ? aiMonthlyCap(db, userId)
      : Promise.resolve(normalizeCost(allowanceUsd)),
  ]);
  const monthTotals = totalsOf(monthRows[0]);
  return {
    day: totalsOf(dayRows[0]),
    month: monthTotals,
    models: modelRows.map((row) => ({
      ...totalsOf(row),
      kind: row.kind as AiUsageKind,
      modelId: row.modelId,
    })),
    since: { day: day.toISOString(), month: month.toISOString() },
    cap: {
      monthlyUsd: cap,
      reached:
        cap !== null &&
        (Number(cap) <= 0 || Number(monthTotals.costUsd) >= Number(cap)),
    },
  };
}
