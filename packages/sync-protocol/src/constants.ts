/** Shared sync constants (docs/cloud-sync-design.md §2). */

/** Origin lease TTL for rotating-auth origins; holders renew while active. */
export const ORIGIN_LEASE_TTL_MS = 60_000;

/** Upper bound the hub clamps a client-requested non-exclusive lease TTL to. */
export const MAX_LEASE_TTL_MS = 300_000;

/** TTL of an exclusive lease taken by a cloud device while it drives a run. */
export const EXCLUSIVE_LEASE_TTL_MS = 120_000;

/** How often a lease holder re-acquires its cached leases (host-driven timer). */
export const LEASE_RENEW_INTERVAL_MS = 40_000;

/** Durable tombstone retention: ≥ 30 days. */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Mass-overwrite rate limit: max cookie mutations per origin per minute
 * accepted from one device before the hub throttles. */
export const MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE = 120;

/** Device revocation propagation contract: tokens and hub sessions dead within 60 s. */
export const REVOCATION_PROPAGATION_MS = 60_000;

/** Default device-token lifetime: 10 minutes (short, silently re-minted). */
export const DEVICE_TOKEN_TTL_SECONDS = 600;

/** Cap on the spaces one hub connection may declare (`hello` / `spaces.update`). */
export const MAX_DECLARED_SPACES = 64;

/**
 * Hard cap on a single hub WebSocket frame, enforced as the server's
 * `maxPayload`. A frame over this closes the socket with 1009, so both
 * directions chunk their multi-record frames below `FRAME_BUDGET_BYTES`.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Byte budget a sender fills before starting another `records` /
 * `workspace.records` frame. Well under `MAX_FRAME_BYTES` so the estimate
 * used to fill it never has to be exact, and above the largest single
 * sealed doc (a 1.5 MB artifact ⇒ ~2 MB base64) so one doc always fits.
 */
export const FRAME_BUDGET_BYTES = 4 * 1024 * 1024;
