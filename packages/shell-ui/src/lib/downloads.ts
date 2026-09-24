/**
 * What the downloads chip says, worked out from the session's records
 * (@pistachio/shell-contracts/browser-controls). Pure, so the chip's wording is testable
 * without a chrome: given the records and the clock, one summary.
 */

import type { BrowserDownload } from "@pistachio/shell-contracts/browser-controls";

/** How long a finished download keeps the chip lit as "Downloaded". */
export const FRESH_MS = 10_000;

export interface DownloadsSummary {
  /** Transfers still receiving bytes. */
  live: number;
  /** Completed within FRESH_MS of `now`, none live. */
  fresh: number;
  /** Cancelled, interrupted, or blocked, whatever their age. */
  failed: number;
  /** Progress across the live transfers, or null while a total is unknown. */
  percent: number | null;
  /** Whether the chip has anything to stand for at all. */
  any: boolean;
}

export function summarizeDownloads(downloads: readonly BrowserDownload[], now: number): DownloadsSummary {
  let live = 0;
  let fresh = 0;
  let failed = 0;
  let received = 0;
  let total = 0;
  let unknownTotal = false;
  for (const download of downloads) {
    switch (download.state) {
      case "progress":
        live += 1;
        received += download.receivedBytes;
        if (download.totalBytes > 0) total += download.totalBytes;
        else unknownTotal = true;
        break;
      case "completed":
        if (download.finishedAt !== null && now - download.finishedAt < FRESH_MS) fresh += 1;
        break;
      case "cancelled":
      case "interrupted":
      case "blocked":
        failed += 1;
        break;
    }
  }
  const percent = live === 0 || unknownTotal || total === 0 ? null : Math.min(100, Math.floor((received / total) * 100));
  return { live, fresh: live === 0 ? fresh : 0, failed, percent, any: downloads.length > 0 };
}

/** The chip's words: a live transfer's progress, a fresh finish, or nothing (the bare icon). */
export function downloadsChipLabel(summary: DownloadsSummary): string | null {
  if (summary.live > 0) {
    const what = summary.live === 1 ? "Downloading" : `Downloading ${String(summary.live)}`;
    return summary.percent === null ? `${what}…` : `${what} ${String(summary.percent)}%`;
  }
  if (summary.fresh > 0) return summary.fresh === 1 ? "Downloaded" : `${String(summary.fresh)} downloaded`;
  return null;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** "1.2 MB" — one decimal from KB up, none for bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${String(Math.round(value))} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${UNITS[unit]}`;
}

/** The one-line status under a download's name. */
export function downloadStatusLine(download: BrowserDownload): string {
  switch (download.state) {
    case "progress":
      return download.totalBytes > 0
        ? `${formatBytes(download.receivedBytes)} of ${formatBytes(download.totalBytes)}`
        : `${formatBytes(download.receivedBytes)} so far`;
    case "completed":
      return download.totalBytes > 0 ? formatBytes(download.totalBytes) : "Completed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Failed";
    case "blocked":
      return download.reason.length > 0 ? `Blocked · ${download.reason}` : "Blocked by policy";
  }
}
