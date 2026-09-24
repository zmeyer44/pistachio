/**
 * Channel outbound replies (docs/cloud-sync-design.md §7.3 "Outbound
 * replies"): `vetOutboundUrl`, the `ChannelWebhookAdapter`, the durable
 * `NotificationScheduleStore` over `notification_occurrences`, and the
 * dispatcher wiring. Control's `NotificationDispatcher` is the only
 * dispatcher; deliveries are idempotent per `(runId, eventId)`.
 */

import { lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import {
  checkResolvedAddress,
  isIpLiteral,
  isLoopbackHost,
  isPrivateHost,
  refusalMessage,
} from "@pistachio/egress-policy";
import {
  NotificationDispatcher,
  NotificationRouter,
  DeliveryLedger,
  type ClaimedNotification,
  type NotificationAdapter,
  type NotificationMessage,
  type NotificationScheduleStore,
  type ScheduledNotification,
} from "@pistachio/notifications";
import type { RunControlEvent, RunEvent } from "@pistachio/protocol";
import type { Db } from "./db/client.js";
import { channelLinks, hostedRuns, notificationOccurrences } from "./db/schema.js";

/* ------------------------------------------------------------------ *
 * URL vetting
 * ------------------------------------------------------------------ */

export class OutboundUrlError extends Error {
  constructor(
    readonly reason:
      | "invalid_url"
      | "scheme"
      | "credentials"
      | "port"
      | "ip_literal"
      | "private_host"
      | "unresolvable"
      | "private_address",
    message: string = reason,
  ) {
    super(message);
  }
}

export interface VetOutboundOptions {
  /** `http:` to `127.0.0.1`/`localhost` is allowed only when false. */
  production: boolean;
}

/**
 * `https:` only (`http:` to `127.0.0.1`/`localhost` when not in production),
 * no credentials, port 443/unset (the dev loopback exception keeps its
 * port), hostname not an IP literal and neither loopback nor private.
 * Returns the normalized URL string.
 */
export function vetOutboundUrl(input: string, options: VetOutboundOptions): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OutboundUrlError("invalid_url");
  }
  const host = url.hostname.toLowerCase();
  const devLoopback =
    !options.production && url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost");
  if (url.protocol !== "https:" && !devLoopback) throw new OutboundUrlError("scheme");
  if (url.username !== "" || url.password !== "") throw new OutboundUrlError("credentials");
  if (devLoopback) return url.toString();
  if (url.port !== "" && url.port !== "443") throw new OutboundUrlError("port");
  if (isIpLiteral(host)) throw new OutboundUrlError("ip_literal");
  if (isLoopbackHost(host) || isPrivateHost(host)) throw new OutboundUrlError("private_host");
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * Webhook adapter
 * ------------------------------------------------------------------ */

export type LookupFn = (host: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (host) => {
  const results = await promisify(dnsLookup)(host, { all: true });
  return results.map((r) => r.address);
};

export const WEBHOOK_TIMEOUT_MS = 10_000;

const WEBHOOK_KIND: Record<NotificationMessage["kind"], string> = {
  judgment: "question",
  approval: "approval",
  completion: "done",
  reminder: "reply",
  step_up: "approval",
};

export interface ChannelWebhookOptions {
  lookup?: LookupFn;
  timeoutMs?: number;
  production: boolean;
}

/**
 * POSTs `{runId, kind, text}` to the link's outbound URL. Before every
 * dispatch the host is resolved with `dns.lookup(host, {all: true})`; an
 * empty answer or any address failing `checkResolvedAddress` refuses the
 * delivery, and only the vetted literals are dialled (a custom `lookup`
 * on the socket). Redirects are errors; the body is discarded.
 */
export class ChannelWebhookAdapter implements NotificationAdapter {
  readonly id: string;

  constructor(
    linkId: string,
    private readonly outboundUrl: string,
    private readonly options: ChannelWebhookOptions,
  ) {
    this.id = `channel:${linkId}`;
  }

  async deliver(message: NotificationMessage, idempotencyKey: string): Promise<void> {
    const url = new URL(vetOutboundUrl(this.outboundUrl, { production: this.options.production }));
    const host = url.hostname;
    let addresses: string[];
    if (isIpLiteral(host)) {
      addresses = [host];
    } else {
      const lookup = this.options.lookup ?? defaultLookup;
      addresses = await lookup(host).catch(() => []);
      if (addresses.length === 0) throw new OutboundUrlError("unresolvable");
      for (const address of addresses) {
        const refusal = checkResolvedAddress(address);
        if (refusal !== null) {
          throw new OutboundUrlError("private_address", `${host} → ${address}: ${refusalMessage(refusal)}`);
        }
      }
    }
    const payload = JSON.stringify({
      runId: message.runId,
      kind: WEBHOOK_KIND[message.kind],
      text: message.body,
    });
    let lastError: unknown = new OutboundUrlError("unresolvable");
    for (const address of addresses) {
      try {
        await this.post(url, address, payload, idempotencyKey);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private post(url: URL, address: string, payload: string, idempotencyKey: string): Promise<void> {
    const family = address.includes(":") ? 6 : 4;
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const timeoutMs = this.options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === "" ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "pistachio-control",
            "X-Pistachio-Delivery": idempotencyKey,
            "Content-Length": Buffer.byteLength(payload),
          },
          // Dial only the vetted literal; TLS still verifies the hostname.
          lookup: (_hostname, opts, callback) => {
            if (typeof opts === "object" && opts.all === true) {
              (callback as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
                null,
                [{ address, family }],
              );
              return;
            }
            (callback as (err: null, address: string, family: number) => void)(null, address, family);
          },
          servername: url.protocol === "https:" ? url.hostname : undefined,
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          res.on("end", () => {
            if (status >= 300 && status < 400) reject(new Error(`webhook redirected (${status})`));
            else if (status < 200 || status >= 300) reject(new Error(`webhook responded ${status}`));
            else resolve();
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("webhook timed out")));
      req.on("error", reject);
      req.end(payload);
    });
  }
}

/* ------------------------------------------------------------------ *
 * Durable schedule store
 * ------------------------------------------------------------------ */

export class PostgresNotificationScheduleStore implements NotificationScheduleStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async schedule(notification: ScheduledNotification): Promise<boolean> {
    const inserted = await this.db
      .insert(notificationOccurrences)
      .values({
        occurrenceId: notification.occurrenceId,
        userId: notification.message.userId,
        fireAt: new Date(notification.fireAt),
        message: notification.message,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: notificationOccurrences.occurrenceId });
    return inserted.length === 1;
  }

  async claimDue(options: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedNotification[]> {
    const now = new Date(options.now);
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(notificationOccurrences)
        .where(
          and(
            lte(notificationOccurrences.fireAt, now),
            or(
              eq(notificationOccurrences.status, "pending"),
              and(
                eq(notificationOccurrences.status, "leased"),
                sql`${notificationOccurrences.leaseUntil} < ${now}`,
              ),
            ),
          ),
        )
        .orderBy(asc(notificationOccurrences.fireAt), asc(notificationOccurrences.occurrenceId))
        .limit(Math.max(0, options.limit))
        .for("update", { skipLocked: true });
      const claimed: ClaimedNotification[] = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        const [updated] = await tx
          .update(notificationOccurrences)
          .set({
            status: "leased",
            leaseOwner: options.workerId,
            leaseToken,
            leaseUntil: new Date(options.now + options.leaseMs),
            attempts: row.attempts + 1,
          })
          .where(eq(notificationOccurrences.occurrenceId, row.occurrenceId))
          .returning({ attempts: notificationOccurrences.attempts });
        claimed.push({
          occurrenceId: row.occurrenceId,
          fireAt: row.fireAt.toISOString(),
          message: row.message,
          leaseToken,
          attempt: updated?.attempts ?? row.attempts + 1,
        });
      }
      return claimed;
    });
  }

  async markSent(occurrenceId: string, leaseToken: string): Promise<boolean> {
    const updated = await this.db
      .update(notificationOccurrences)
      .set({ status: "sent", leaseOwner: null, leaseToken: null, leaseUntil: null })
      .where(
        and(
          eq(notificationOccurrences.occurrenceId, occurrenceId),
          eq(notificationOccurrences.status, "leased"),
          eq(notificationOccurrences.leaseToken, leaseToken),
        ),
      )
      .returning({ id: notificationOccurrences.occurrenceId });
    return updated.length === 1;
  }

  async release(
    occurrenceId: string,
    leaseToken: string,
    error: string,
    retry: boolean,
  ): Promise<boolean> {
    const updated = await this.db
      .update(notificationOccurrences)
      .set({
        status: retry ? "pending" : "failed",
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        lastError: error.slice(0, 1024),
        // Retry after a short backoff so a transient failure is not spun on.
        fireAt: retry ? new Date(this.now() + 5_000) : undefined,
      })
      .where(
        and(
          eq(notificationOccurrences.occurrenceId, occurrenceId),
          eq(notificationOccurrences.status, "leased"),
          eq(notificationOccurrences.leaseToken, leaseToken),
        ),
      )
      .returning({ id: notificationOccurrences.occurrenceId });
    return updated.length === 1;
  }
}

/* ------------------------------------------------------------------ *
 * Router: one webhook adapter per link, resolved per message
 * ------------------------------------------------------------------ */

export interface ChannelRouterDeps {
  db: Db;
  webhook: ChannelWebhookOptions;
}

/**
 * Routes each message to the `ChannelWebhookAdapter` (`id: channel:<linkId>`)
 * of the link that originated the run (`hosted_runs.origin`). A run that did
 * not come from a channel, a revoked link, or a link without an outbound URL
 * drops the delivery silently.
 */
export class ChannelRouter extends NotificationRouter {
  private readonly ledger = new DeliveryLedger();

  constructor(private readonly deps: ChannelRouterDeps) {
    super([]);
  }

  override async deliver(message: NotificationMessage): Promise<void> {
    const [run] = await this.deps.db
      .select({ origin: hostedRuns.origin })
      .from(hostedRuns)
      .where(eq(hostedRuns.id, message.runId));
    const origin = run?.origin ?? null;
    if (origin === null || origin.kind !== "channel") return;
    const [link] = await this.deps.db
      .select({ outboundUrl: channelLinks.outboundUrl, revokedAt: channelLinks.revokedAt })
      .from(channelLinks)
      .where(eq(channelLinks.id, origin.linkId));
    if (link === undefined || link.revokedAt !== null || link.outboundUrl === null) return;
    const adapter = new ChannelWebhookAdapter(origin.linkId, link.outboundUrl, this.deps.webhook);
    await new NotificationRouter([adapter], this.ledger).deliver(message);
  }
}

const TITLES: Record<NotificationMessage["kind"], string> = {
  judgment: "The agent has a question",
  approval: "The agent needs you",
  completion: "Run finished",
  reminder: "Reply from the agent",
  step_up: "Step-up required",
};

/** The notification a run event produces for a channel-originated run, if any. */
export function notificationFor(input: {
  runId: string;
  userId: string;
  eventId: string;
  event: RunEvent;
  controlPublicUrl: string;
  now: number;
}): ScheduledNotification | null {
  const described = describeEvent(input.event);
  if (described === null) return null;
  const occurrenceId = `${input.runId}:${input.eventId}`;
  return {
    occurrenceId,
    fireAt: new Date(input.now).toISOString(),
    message: {
      id: occurrenceId,
      userId: input.userId,
      runId: input.runId,
      kind: described.kind,
      title: TITLES[described.kind],
      body: described.body,
      actionUrl: `${input.controlPublicUrl.replace(/\/+$/, "")}/runs/${input.runId}`,
      capabilityCeiling: [],
    },
  };
}

function describeEvent(event: RunEvent): { kind: NotificationMessage["kind"]; body: string } | null {
  switch (event.t) {
    case "question.asked":
      return { kind: "judgment", body: "The agent has a question. Open the run to answer it." };
    case "takeover.requested":
      return { kind: "approval", body: "The agent needs you to take over the browser." };
    case "reply":
      return { kind: "reminder", body: event.text };
    case "status":
      return isTerminal(event) ? { kind: "completion", body: `Run ${event.status}.` } : null;
    default:
      return null;
  }
}

function isTerminal(event: Extract<RunControlEvent, { t: "status" }>): boolean {
  return (
    event.status === "completed" ||
    event.status === "failed" ||
    event.status === "revoked" ||
    event.status === "rejected"
  );
}

export function createChannelDispatcher(deps: ChannelRouterDeps & { now?: () => number }): {
  dispatcher: NotificationDispatcher;
  store: PostgresNotificationScheduleStore;
} {
  const store = new PostgresNotificationScheduleStore(deps.db, deps.now);
  const dispatcher = new NotificationDispatcher({
    router: new ChannelRouter(deps),
    store,
    currentCapabilityCeiling: () => Promise.resolve([]),
    maxAttempts: 3,
  });
  return { dispatcher, store };
}
