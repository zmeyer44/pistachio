/**
 * The runner's HTTP surface (docs/cloud-sync-design.md §8.6): `/healthz`,
 * `POST /v1/devices/provision` and `POST /v1/tasks/steer` under the service
 * bearer. The live-view WebSocket upgrade is attached to the Node server
 * separately (live/server.ts).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { RUN_CONTENT_EVENT_KINDS, TASK_STATUSES, type IMessageThreadRouteRequest, type IMessageThreadRouteResult } from "@pistachio/protocol";
import type { ProvisionResult } from "./identity/provision.js";
import { errorMessage, silentLogger, type Logger } from "./logger.js";
import { readJsonBody, RequestBodyTooLargeError } from "./request-body.js";

const MAX_CONTROL_REQUEST_BYTES = 64 * 1024;
const MAX_ROUTING_REQUEST_BYTES = 512 * 1024;

export const provisionBodySchema = z.object({
  userId: z.uuid(),
  nonce: z.string().min(1).max(512),
});

export const steerBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device.revoked"), userId: z.uuid(), deviceId: z.uuid() }),
  z.object({ kind: z.literal("run.command"), runId: z.uuid(), command: z.unknown() }),
  // The person ended a browser session (web-browser-design.md §4.3): every
  // viewer of it goes, and the Chromium context behind it with them.
  z.object({ kind: z.literal("session.ended"), sessionId: z.uuid() }),
]);

/**
 * Sponsor command ids are `${t}:${runId}:${idempotencyKey}:${index}` with a
 * client key of up to 128 characters, so the envelope is well over 128.
 */
const MAX_ROUTING_EVENT_ID_CHARACTERS = 256;

const routingEventSchema = z.object({
  eventId: z.string().min(1).max(MAX_ROUTING_EVENT_ID_CHARACTERS),
  at: z.iso.datetime(),
  event: z.union([
    z.object({
      t: z.literal("sealed"),
      spaceId: z.string().min(1).max(128),
      sealed: z.string().min(1),
      kind: z.enum(RUN_CONTENT_EVENT_KINDS).optional(),
    }),
    z.object({ t: z.literal("cmd.message"), text: z.string().min(1).max(16_384) }),
    z.object({ t: z.literal("cmd.answer"), questionId: z.string().min(1).max(128), value: z.string().max(16_384) }),
  ]),
});

export const imessageRouteBodySchema = z.object({
  candidate: z.object({
    runId: z.uuid(),
    userId: z.uuid(),
    spaceId: z.string().min(1).max(128),
    intent: z.string().min(1).max(16_384),
    status: z.enum(TASK_STATUSES),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    lastIMessageAt: z.iso.datetime(),
  }),
  incoming: z.object({
    text: z.string().min(1).max(16_384),
    receivedAt: z.iso.datetime(),
  }),
  events: z.array(routingEventSchema).max(200),
});

export type SteerBody = z.infer<typeof steerBodySchema>;

export interface CloudBrowserAppOptions {
  serviceToken: string;
  provision: (userId: string, nonce: string) => Promise<ProvisionResult>;
  /**
   * Acknowledged with 204 as soon as the body is valid; the work runs in the
   * background. Control gives a steer 2 s and retries failures from its
   * outbox, while a revocation teardown calls back into control (fail the
   * runs) and must not sit inside that window.
   */
  steer: (body: SteerBody) => Promise<void>;
  /**
   * Liveness beyond "Node answers": the browser's state. `disconnected`
   * makes `/healthz` answer 503 so the platform restarts a worker whose
   * Chromium is gone instead of routing runs to it.
   */
  health?: () => { browser: "not_started" | "connected" | "disconnected" };
  /**
   * Decrypts candidate history and classifies this iMessage synchronously.
   * `signal` aborts when control gives up on the request, so no model call
   * completes (and bills) for an answer nobody will read.
   */
  routeIMessage: (input: IMessageThreadRouteRequest, signal: AbortSignal) => Promise<IMessageThreadRouteResult>;
  log?: Logger;
}

export function createCloudBrowserApp(options: CloudBrowserAppOptions): Hono {
  const log = options.log ?? silentLogger;
  const app = new Hono();
  app.get("/healthz", (context) => {
    const health = options.health?.() ?? { browser: "not_started" as const };
    const ok = health.browser !== "disconnected";
    return context.json({ ok, ...health }, ok ? 200 : 503);
  });

  app.post("/v1/devices/provision", async (context) => {
    if (!bearerMatches(context.req.header("authorization"), options.serviceToken)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const body = await parseBody(context.req.raw);
    if (body.kind === "too_large") return context.json({ error: "payload_too_large" }, 413);
    if (body.kind === "invalid") return context.json({ error: "invalid_json" }, 400);
    const parsed = provisionBodySchema.safeParse(body.value);
    if (!parsed.success) return context.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    const result = await options.provision(parsed.data.userId, parsed.data.nonce);
    if (result.status === 409) return context.json({ error: result.error }, 409);
    return context.json({ device: result.device }, result.status);
  });

  app.post("/v1/tasks/steer", async (context) => {
    if (!bearerMatches(context.req.header("authorization"), options.serviceToken)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const body = await parseBody(context.req.raw);
    if (body.kind === "too_large") return context.json({ error: "payload_too_large" }, 413);
    if (body.kind === "invalid") return context.json({ error: "invalid_json" }, 400);
    const parsed = steerBodySchema.safeParse(body.value);
    if (!parsed.success) return context.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    options.steer(parsed.data).catch((error: unknown) => {
      log.error("steer failed", { kind: parsed.data.kind, error: errorMessage(error) });
    });
    return context.body(null, 204);
  });

  app.post("/v1/imessage/route", async (context) => {
    if (!bearerMatches(context.req.header("authorization"), options.serviceToken)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const body = await parseBody(context.req.raw, MAX_ROUTING_REQUEST_BYTES);
    if (body.kind === "too_large") return context.json({ error: "payload_too_large" }, 413);
    if (body.kind === "invalid") return context.json({ error: "invalid_json" }, 400);
    const parsed = imessageRouteBodySchema.safeParse(body.value);
    if (!parsed.success) return context.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    const input: IMessageThreadRouteRequest = parsed.data;
    const result = await options.routeIMessage(input, context.req.raw.signal);
    return context.json(result);
  });

  return app;
}

type ParsedBody = { kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too_large" };

async function parseBody(request: Request, maximumBytes = MAX_CONTROL_REQUEST_BYTES): Promise<ParsedBody> {
  try {
    return { kind: "ok", value: await readJsonBody(request, maximumBytes) };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return { kind: "too_large" };
    return { kind: "invalid" };
  }
}

export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ") || expected === "") return false;
  const actualDigest = createHash("sha256").update(header.slice(7).trim()).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
