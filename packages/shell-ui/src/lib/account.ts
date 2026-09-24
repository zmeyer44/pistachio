/**
 * What Settings → Account and Settings → Devices say about the account, the
 * keys, and the machines that hold them (docs/cloud-sync-design.md §10.1).
 *
 * Pure: every function here turns main's published state into words. The
 * defaults are what the store shows while the first `account:get` is in
 * flight or after it failed — the shell must never wait on the control plane
 * to finish opening, so a Mac with no account renders the signed-out page
 * rather than a spinner.
 */

import type { AccountState, AiUsageModelTotals, AiUsageTotals, DeviceInfo, KeyFingerprint } from "@pistachio/shell-contracts/ipc";
import { relativeTime } from "./run";

/** No account, no keys, and no keychain until main says otherwise. */
export const DEFAULT_ACCOUNT: AccountState = {
  state: "unenrolled",
  email: null,
  userId: null,
  deviceId: null,
  deviceName: "This Mac",
  controlUrl: "",
  encryptionAvailable: false,
  cloudDevicePin: null,
  revoked: false,
  hubUrl: null,
  cloudBrowserUrl: null,
  error: null,
};

/**
 * A key fingerprint as a person compares it across two screens: 8 groups of
 * 4 hex digits. Main already publishes that shape; this normalizes whatever
 * arrives (missing spaces, upper case, a longer digest) so the two columns
 * of a comparison always line up, and answers "" for anything that is not a
 * fingerprint at all.
 */
export function fingerprintGroups(fingerprint: KeyFingerprint): string[] {
  const hex = fingerprint.toLowerCase().replace(/[^0-9a-f]/g, "");
  // All eight groups or none: a half-rendered fingerprint invites a
  // comparison that proves nothing, and main answers "" for a key it could
  // not read at all.
  if (hex.length < 32) return [];
  return hex.slice(0, 32).match(/.{4}/g) ?? [];
}

/** The same 8 groups on one line, for a title or a copy. */
export function formatFingerprint(fingerprint: KeyFingerprint): string {
  return fingerprintGroups(fingerprint).join(" ");
}

/** What the account pages have to ask this Mac for next. */
export type AccountStep = "sign-in" | "enroll" | "done";

/**
 * A revoked device keeps reporting `state: "enrolled"`: main clears its
 * token and sets `revoked`, and the bootstrap token enrollment needs went
 * with the token, so the only way back in is a fresh sign-in — the enrolled
 * page has no button that would work. A Mac that signed up but could not
 * enroll is the mirror case: the account already exists, so signing up for
 * it again is refused and only the enrollment should be retried.
 */
export function accountStep(account: AccountState): AccountStep {
  // An anonymous account (docs/anonymous-accounts.md) is nobody signed in:
  // signing up from it upgrades it in place, signing in folds it in.
  if (account.revoked || account.state === "unenrolled" || account.state === "anonymous") return "sign-in";
  return account.state === "enrolled" ? "done" : "enroll";
}

/**
 * The control error code inside a rejection that crossed IPC. Main answers
 * these handlers with the control client's promise and Electron flattens a
 * rejection to its message, so `ControlError.code` survives only as the word
 * in `control: <status> <code> (METHOD /path)`. Null when control sent an
 * explanation instead of a code, or when the rejection came from anywhere
 * else — both mean "no code to act on", never a wrong one.
 */
export function controlErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return /control: \d{3} ([a-z0-9_]+) \([A-Z]+ \//.exec(message)?.[1] ?? null;
}

/** Where this Mac stands, in one word. */
export function accountStateLabel(account: AccountState): string {
  if (account.revoked) return "Revoked";
  if (account.state === "enrolled") return "Enrolled";
  if (account.state === "signed-up") return "Signed up";
  return "Not signed in";
}

export function accountStateTone(account: AccountState): "green" | "amber" | "gray" | "red" {
  if (account.revoked) return "red";
  if (account.state === "enrolled") return "green";
  if (account.state === "signed-up") return "amber";
  return "gray";
}

/** "This Mac" for the device you are on, otherwise what kind of device it is. */
export function devicePlatformLabel(device: DeviceInfo): string {
  if (device.isThisDevice) return "This Mac";
  if (device.platform === "cloud") return "Cloud browser";
  return device.platform === "web" ? "Web browser" : "Mac";
}

export function deviceIsRevoked(device: DeviceInfo): boolean {
  return device.revokedAt !== null;
}

/** "Last seen 5m ago" / "Revoked 3d ago" / "Never connected". */
export function deviceSeenLabel(device: DeviceInfo, now: number = Date.now()): string {
  if (device.revokedAt !== null) {
    const when = relativeTime(device.revokedAt, now);
    return when === "" ? "Revoked" : `Revoked ${when}`;
  }
  if (device.isThisDevice) return "Active now";
  if (device.lastSeenAt === null) return "Never connected";
  const when = relativeTime(device.lastSeenAt, now);
  return when === "" ? "Never connected" : `Last seen ${when}`;
}

/**
 * This Mac first, then the devices still enrolled by how recently they were
 * seen, then the revoked ones. A list a person scans for "which of these is
 * mine" reads best when the answer is the first row.
 */
export function sortDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((a, b) => {
    if (a.isThisDevice !== b.isThisDevice) return a.isThisDevice ? -1 : 1;
    const aRevoked = deviceIsRevoked(a);
    const bRevoked = deviceIsRevoked(b);
    if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
    const seen = seenAt(b) - seenAt(a);
    if (seen !== 0) return seen;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/* ------------------------------ model usage ------------------------------ */

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
export function formatUsd(cost: string): string {
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
  // The address bar's intent model: no text generated, one tiny call per
  // typed phrase (docs/smart-suggestions.md).
  "evaluation-model": "Suggestions",
};

/** The model's name, or its kind when the request named none. */
export function modelUsageLabel(row: Pick<AiUsageModelTotals, "kind" | "modelId">): string {
  if (row.modelId !== null && row.modelId !== "") return row.modelId;
  return KIND_LABELS[row.kind] ?? "Other";
}

function seenAt(device: DeviceInfo): number {
  const value = Date.parse(device.revokedAt ?? device.lastSeenAt ?? device.createdAt ?? "");
  return Number.isNaN(value) ? 0 : value;
}
