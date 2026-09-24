/**
 * zod 4 request validation (docs/cloud-sync-design.md §7.9). No
 * `@hono/zod-validator`: each middleware parses one part of the request and
 * stores the typed result on the context (`body`, `query`, `param`).
 */

import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { fromBase64 } from "@pistachio/sync-protocol";
import type { AppEnv } from "./env.js";

export interface ValidatedVariables {
  body: unknown;
  query: unknown;
  param: unknown;
}

export function validate<S extends z.ZodType>(schema: S): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const r = schema.safeParse(await c.req.json().catch(() => undefined));
    if (!r.success) return c.json({ error: "invalid_body", issues: r.error.issues }, 400);
    c.set("body", r.data);
    await next();
  };
}

export function validateQuery<S extends z.ZodType>(schema: S): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const r = schema.safeParse(c.req.query());
    if (!r.success) return c.json({ error: "invalid_query", issues: r.error.issues }, 400);
    c.set("query", r.data);
    await next();
  };
}

export function validateParam<S extends z.ZodType>(schema: S): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const r = schema.safeParse(c.req.param());
    if (!r.success) return c.json({ error: "invalid_param", issues: r.error.issues }, 400);
    c.set("param", r.data);
    await next();
  };
}

/** The parsed body a `validate(schema)` middleware stored, typed by the schema. */
export function body<S extends z.ZodType>(c: Context<AppEnv>, _schema: S): z.infer<S> {
  return c.get("body") as z.infer<S>;
}

export function query<S extends z.ZodType>(c: Context<AppEnv>, _schema: S): z.infer<S> {
  return c.get("query") as z.infer<S>;
}

export function param<S extends z.ZodType>(c: Context<AppEnv>, _schema: S): z.infer<S> {
  return c.get("param") as z.infer<S>;
}

/** A base64 string, optionally of an exact decoded length. */
export function base64String(byteLength?: number, maxChars?: number): z.ZodType<string> {
  const base = maxChars === undefined ? z.string() : z.string().max(maxChars);
  return base.refine(
    (s) => {
      try {
        const decoded = fromBase64(s);
        return byteLength === undefined || decoded.length === byteLength;
      } catch {
        return false;
      }
    },
    byteLength === undefined ? "must be base64" : `must be base64 of ${byteLength} bytes`,
  );
}

export const SPACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SPACE_OR_WORKSPACE_ID_RE = /^([a-z0-9][a-z0-9-]{0,63}|__workspace__)$/;

export const spaceIdSchema = z.string().regex(SPACE_ID_RE);
export const spaceOrWorkspaceIdSchema = z.string().regex(SPACE_OR_WORKSPACE_ID_RE);
