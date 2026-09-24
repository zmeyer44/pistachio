/**
 * The model meter, in words. Pure: what Settings says about the account's
 * spend comes from here, so the page and the desktop's own card can agree.
 */

import type { AiUsageModelTotals, AiUsageTotals } from "./control";

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** "950", "12.3K", "1.2M": a token count at a glance. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  return count < 1_000 ? String(Math.round(count)) : COMPACT.format(count);
}

/**
 * The gateway's decimal string as money: cents when there are any, four
 * places below that so a day of small calls does not round to nothing.
 */
export function formatUsd(cost: string | number): string {
  const value = Number(cost);
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** "12 requests · 1.2K in · 340 out", or what an empty meter says. */
export function usageLine(totals: AiUsageTotals): string {
  if (totals.requests === 0) return "No model calls yet.";
  const requests = `${String(totals.requests)} ${totals.requests === 1 ? "request" : "requests"}`;
  if (totals.inputTokens === 0 && totals.outputTokens === 0) return requests;
  return `${requests} · ${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`;
}

const KIND_LABELS: Record<string, string> = {
  "language-model": "Chat",
  "embedding-model": "Embeddings",
  "speech-model": "Speech",
  "transcription-model": "Transcription",
  "image-model": "Images",
  "reranking-model": "Reranking",
  "video-model": "Video",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? "Other";
}

/** The model's name, or its kind when the request named none. */
export function modelUsageLabel(row: Pick<AiUsageModelTotals, "kind" | "modelId">): string {
  if (row.modelId !== null && row.modelId !== "") return row.modelId;
  return kindLabel(row.kind);
}

/** How much of the cap the month has used, 0..1; null with no cap. */
export function capFraction(spentUsd: string, capUsd: string | null): number | null {
  if (capUsd === null) return null;
  const cap = Number(capUsd);
  const spent = Number(spentUsd);
  if (!Number.isFinite(cap) || cap <= 0) return 1;
  if (!Number.isFinite(spent) || spent <= 0) return 0;
  return Math.min(1, spent / cap);
}

/** The meter's colour for a fraction of the cap. */
export function capTone(fraction: number | null): "ok" | "warn" | "alert" {
  if (fraction === null || fraction < 0.8) return "ok";
  return fraction >= 1 ? "alert" : "warn";
}

/** The reader's typed cap, as the wire wants it: a plain decimal string or null. Undefined when it is not a number. */
export function parseCapInput(text: string): string | null | undefined {
  const cleaned = text.replace(/[$,\s]/gu, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return String(value);
}
