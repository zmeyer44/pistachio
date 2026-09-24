/** How Watchtower says when, how big, and how complete — the same on every surface. */

import type { WatchtowerHit } from "@pistachio/shell-contracts/watchtower";

export const formatMoment = (at: number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const formatTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Today", "Yesterday", then the date — the heading a day of visits sits under. */
export function formatDay(at: number, now = Date.now()): string {
  const day = (value: number): number => new Date(value).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, {
    weekday: days < 7 ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: new Date(at).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

export const KIND_LABEL: Record<WatchtowerHit["kind"], string> = {
  article: "Article",
  page: "Page",
  video: "Video",
};

/** Null for a complete capture: only the exceptions are worth a badge. */
export function coverageLabel(coverage: WatchtowerHit["coverage"]): string | null {
  return coverage === "partial"
    ? "Partial"
    : coverage === "metadata"
      ? "Title only"
      : coverage === "expired"
        ? "Text expired"
        : null;
}

export const COVERAGE_NOTE: Record<Exclude<WatchtowerHit["coverage"], "complete">, string> = {
  partial: "The page was large or busy, so only part of its text was saved.",
  metadata: "Only the title and address were saved: the visit was brief, the site is excluded from extraction, or storage was full.",
  expired: "The saved text of this visit expired under your retention setting. The visit itself is kept.",
};
