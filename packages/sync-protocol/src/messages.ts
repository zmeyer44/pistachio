/**
 * Sync wire protocol (JSON encoding over WebSockets between the desktop /
 * cloud-browser engines and the hub hosted in the control-plane process).
 *
 * Zod schemas are the source of truth; both the hub (server) and the clients
 * validate every frame with them.
 */

import { z } from "zod";
import { CAUSES } from "./cookie.js";
import { DEVICE_KINDS } from "./device.js";
import { FRAME_BUDGET_BYTES, MAX_FRAME_BYTES } from "./constants.js";
import { compareHlc, type Hlc } from "./hlc.js";

/* ------------------------------------------------------------------ *
 * Core wire shapes
 * ------------------------------------------------------------------ */

export const hlcSchema = z.object({
  physicalMs: z.number().int().nonnegative(),
  logical: z.number().int().nonnegative(),
  deviceId: z.string().min(1),
});

export const causeSchema = z.enum(CAUSES);

/** `desktop` or `cloud`; the hub binds it from the device token, never the frame (D10). */
export const deviceKindSchema = z.enum(DEVICE_KINDS);

/**
 * Reference to the exact version a mutation supersedes:
 * `${recordIdHex}@${physicalMs.toString(16)}-${logical.toString(16)}-${deviceId}`.
 */
export const versionTokenSchema = z.string().min(1);
export type VersionToken = z.infer<typeof versionTokenSchema>;

export function makeVersionToken(recordIdHex: string, hlc: Hlc): VersionToken {
  return `${recordIdHex}@${hlc.physicalMs.toString(16)}-${hlc.logical.toString(16)}-${hlc.deviceId}`;
}

export function parseVersionToken(token: VersionToken): {
  recordId: string;
  hlc: Hlc;
} {
  const at = token.indexOf("@");
  if (at < 0) throw new Error("malformed version token");
  const recordId = token.slice(0, at);
  const rest = token.slice(at + 1);
  const first = rest.indexOf("-");
  const second = rest.indexOf("-", first + 1);
  if (first < 0 || second < 0) throw new Error("malformed version token");
  const physicalMs = Number.parseInt(rest.slice(0, first), 16);
  const logical = Number.parseInt(rest.slice(first + 1, second), 16);
  const deviceId = rest.slice(second + 1);
  if (Number.isNaN(physicalMs) || Number.isNaN(logical) || !deviceId) {
    throw new Error("malformed version token");
  }
  return { recordId, hlc: { physicalMs, logical, deviceId } };
}

/** The sealed, signed unit of cookie sync. */
export const cookieRecordWireSchema = z.object({
  spaceId: z.string().min(1),
  /** HMAC(identity tuple), hex — server-visible, pseudonymous. */
  recordId: z.string().regex(/^[0-9a-f]{64}$/),
  /** HMAC(host key), hex — lease/rollback scoping. */
  originId: z.string().regex(/^[0-9a-f]{64}$/),
  /** base64 sealed CookiePlain (identity + attributes + deleted flag). */
  sealedRecord: z.string().min(1),
  hlc: hlcSchema,
  /** Version this mutation supersedes; null for first-ever write. */
  causalParent: versionTokenSchema.nullable(),
  /** base64 Ed25519 signature over recordSigningBytes(). */
  deviceSig: z.string().min(1),
  cause: causeSchema,
});
export type CookieRecordWire = z.infer<typeof cookieRecordWireSchema>;

/** Workspace metadata document (spaces / settings / device docs), LWW+HLC. */
export const workspaceRecordWireSchema = z.object({
  /** Doc key from workspaceKeyFor(): `space:<id>` | `settings:<field>` | `device-workspace:<deviceId>` | `device-activity:<deviceId>`. */
  key: z.string().min(1),
  /** base64 sealed JSON value; null ⇒ deleted. */
  sealedValue: z.string().nullable(),
  hlc: hlcSchema,
  deviceSig: z.string().min(1),
});
export type WorkspaceRecordWire = z.infer<typeof workspaceRecordWireSchema>;

export const devicePresenceSchema = z.object({
  deviceId: z.string().min(1),
  kind: deviceKindSchema,
  online: z.boolean(),
  lastSeenMs: z.number().int().nonnegative(),
});
export type DevicePresence = z.infer<typeof devicePresenceSchema>;

/* ------------------------------------------------------------------ *
 * Client → server
 * ------------------------------------------------------------------ */

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    deviceId: z.string().min(1),
    /** Client self-check only; the hub binds kind from the token (D10, D24). */
    kind: deviceKindSchema,
    spaceIds: z.array(z.string().min(1)),
  }),
  z.object({
    t: z.literal("publish"),
    records: z.array(cookieRecordWireSchema).min(1),
  }),
  z.object({
    t: z.literal("hydrate"),
    spaceId: z.string().min(1),
    sinceHlc: hlcSchema.nullable(),
  }),
  z.object({
    t: z.literal("lease.acquire"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    force: z.boolean().optional(),
    /** Required for a forced handoff; hub verifies it beats the stored winner. */
    recordId: z.string().min(1).optional(),
    candidateHlc: hlcSchema.optional(),
    /** Honored only for cloud devices; a desktop's `true` is treated as false. */
    exclusive: z.boolean().optional(),
    ttlMs: z.number().int().positive().optional(),
  }),
  z.object({
    t: z.literal("lease.release"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
  }),
  z.object({
    t: z.literal("rollback"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    toHlc: hlcSchema,
  }),
  z.object({
    t: z.literal("workspace.publish"),
    docs: z.array(workspaceRecordWireSchema).min(1),
  }),
  z.object({
    t: z.literal("workspace.hydrate"),
    sinceHlc: hlcSchema.nullable(),
  }),
  z.object({
    t: z.literal("spaces.update"),
    spaceIds: z.array(z.string().min(1)),
  }),
  z.object({ t: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/* ------------------------------------------------------------------ *
 * Server → client
 * ------------------------------------------------------------------ */

/**
 * Why the hub refused to store a published record. `stale` is the only
 * durable outcome (the hub already holds this record or a newer winner);
 * every other reason means nothing was stored and the record may go out
 * again.
 *
 * The wire field is deliberately OPEN: a reason a newer hub adds must not
 * fail the whole `publish.ack` frame — a strict enum would drop the frame in
 * `parseServerMessage` and strand every record in that batch. An
 * unrecognised value normalizes to `unknown`, which consumers must treat as
 * retryable and never as a durability confirmation.
 */
export const PUBLISH_REJECTION_REASONS = [
  "lease_required",
  "exclusive_lease",
  "bad_signature",
  "stale",
  "malformed",
  "rate_limited",
  // The record's physical clock is implausibly far ahead of the hub's. The
  // record is well-formed and the writer is authentic, so this is retryable:
  // it clears on its own once wall time catches up. A client that does not
  // know the reason parses it as `unknown`, which is retryable too.
  "clock_drift",
  "unknown",
] as const;
export type PublishRejectionReason = (typeof PUBLISH_REJECTION_REASONS)[number];

export const publishRejectionSchema = z.object({
  recordId: z.string(),
  reason: z.enum(PUBLISH_REJECTION_REASONS).catch("unknown"),
});
export type PublishRejection = z.infer<typeof publishRejectionSchema>;

/** Error codes the hub sends in `error` frames. `code` stays an open string on the wire. */
export const HUB_ERROR_CODES = [
  "hello_required",
  "malformed",
  "rate_limited",
  "too_many_spaces",
  "device_mismatch",
] as const;
export type HubErrorCode = (typeof HUB_ERROR_CODES)[number];

export const serverMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello.ack"),
    serverTimeMs: z.number().int().nonnegative(),
    presence: z.array(devicePresenceSchema),
  }),
  z.object({
    t: z.literal("publish.ack"),
    accepted: z.array(z.string()),
    rejected: z.array(publishRejectionSchema),
  }),
  z.object({
    t: z.literal("records"),
    spaceId: z.string().min(1),
    records: z.array(cookieRecordWireSchema),
  }),
  z.object({
    t: z.literal("hydrate.done"),
    spaceId: z.string().min(1),
    count: z.number().int().nonnegative(),
    watermark: hlcSchema.nullable(),
  }),
  z.object({
    t: z.literal("lease.granted"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    holderDeviceId: z.string().min(1),
    expiresAtMs: z.number().int().nonnegative(),
    exclusive: z.boolean(),
  }),
  z.object({
    t: z.literal("lease.denied"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    holderDeviceId: z.string().min(1),
    holderKind: deviceKindSchema,
    exclusive: z.boolean(),
    expiresAtMs: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal("lease.revoked"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    newHolderDeviceId: z.string().min(1),
  }),
  z.object({
    t: z.literal("lease.released"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
  }),
  z.object({
    t: z.literal("rollback.applied"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    toHlc: hlcSchema,
  }),
  z.object({
    t: z.literal("workspace.records"),
    docs: z.array(workspaceRecordWireSchema),
  }),
  z.object({
    t: z.literal("workspace.hydrate.done"),
    count: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal("spaces.update.ack"),
    spaceIds: z.array(z.string().min(1)),
  }),
  z.object({
    t: z.literal("presence"),
    devices: z.array(devicePresenceSchema),
  }),
  z.object({ t: z.literal("pong") }),
  z.object({
    t: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(raw: string): ClientMessage {
  return clientMessageSchema.parse(JSON.parse(raw));
}

export function parseServerMessage(raw: string): ServerMessage {
  return serverMessageSchema.parse(JSON.parse(raw));
}

/** Sort records oldest-first by HLC — hydration and queue-drain order. */
export function sortByHlc<T extends { hlc: Hlc }>(records: T[]): T[] {
  return [...records].sort((a, b) => compareHlc(a.hlc, b.hlc));
}

/* ------------------------------------------------------------------ *
 * Frame sizing
 *
 * A `records` / `workspace.records` frame carries an unbounded number of
 * records, and a sealed artifact doc is ~2 MB of base64 on its own, so a
 * frame built by count alone can pass the socket's `maxPayload` and close
 * the connection (1009) — taking every other doc in the lane down with it.
 * Senders fill `FRAME_BUDGET_BYTES` instead, using these estimates.
 * ------------------------------------------------------------------ */

/** JSON envelope allowance per record: field names, hlc, quoting, commas. */
const RECORD_ENVELOPE_BYTES = 256;

/** Estimated JSON size of one sealed cookie record on the wire. */
export function cookieRecordBytes(record: CookieRecordWire): number {
  return (
    record.sealedRecord.length +
    record.deviceSig.length +
    record.spaceId.length +
    (record.causalParent?.length ?? 0) +
    RECORD_ENVELOPE_BYTES
  );
}

/** Estimated JSON size of one sealed workspace doc on the wire. */
export function workspaceRecordBytes(doc: WorkspaceRecordWire): number {
  return (
    (doc.sealedValue?.length ?? 0) +
    doc.deviceSig.length +
    doc.key.length +
    RECORD_ENVELOPE_BYTES
  );
}

/**
 * Split `items` into frames of at most `maxCount` items and
 * `FRAME_BUDGET_BYTES` estimated bytes, preserving order.
 *
 * An item bigger than the budget still gets its own frame: `MAX_FRAME_BYTES`
 * is twice the budget precisely so one outsized record travels rather than
 * being lost. An item bigger than `MAX_FRAME_BYTES` cannot travel at all —
 * sending it closes the socket with 1009 and takes the whole lane down, on
 * this connection and on every reconnect after it. Those are withheld and
 * reported through `onOversized`, so one undeliverable record costs itself
 * instead of costing every other record beside it. Callers must report
 * them; a silent drop would be a record that never syncs and never says so.
 */
export function chunkFrames<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  maxCount: number,
  onOversized?: (item: T, bytes: number) => void,
): T[][] {
  const frames: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (size > MAX_FRAME_BYTES) {
      onOversized?.(item, size);
      continue;
    }
    if (
      current.length > 0 &&
      (current.length >= maxCount || bytes + size > FRAME_BUDGET_BYTES)
    ) {
      frames.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) frames.push(current);
  return frames;
}
