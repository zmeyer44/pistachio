/**
 * The wire contract for reports: what the shell asks the host for and what it
 * gets back. Types and limits only — nothing here calls a model.
 */
import type { Spec } from "@json-render/core";
import { z } from "zod";

export const REPORT_KINDS = ["daily_brief"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** The page a brief is read on. `pistachio://brief/` is today; a date path is that day's. */
export const BRIEF_PAGE_URL = "pistachio://brief/";
export const BRIEF_PAGE_TITLE = "Daily Brief";

export const REPORT_LIMITS = {
  /** Briefs kept per Space; older days are dropped when a new one is stored. */
  archiveDays: 30,
  events: 24,
  messages: 20,
  reminders: 12,
  todos: 12,
  pages: 12,
  threads: 6,
  /** State changes the page may write back. Only ticks: a report's content is not editable. */
  stateChanges: 50,
} as const;

/** How one source answered when the brief was gathered. Mirrors the calendar agenda's states. */
export type ReportSourceState = "ok" | "not_connected" | "reconnect_required" | "unreachable" | "off" | "empty";

export interface ReportSourceStatus {
  source: "calendar" | "gmail" | "reminders" | "todos" | "watchtower" | "threads";
  state: ReportSourceState;
  /** Whether a Connect prompt would lead somewhere (signed in, and the server offers the provider). */
  connectable: boolean;
  accountLabel: string | null;
  count: number;
}

export interface ReportBuiltWith {
  /** `jev`: the evaluation model composed the page. `default`: the built-in layout (no model, or it failed). */
  composer: "jev" | "default";
  composerModel: string | null;
  /** The language model that wrote the headline, or null when the template wrote it. */
  writer: string | null;
  triage: "jev" | "rules";
  evaluations: number;
  elapsedMs: number;
}

export interface ReportRecord {
  id: string;
  kind: ReportKind;
  spaceId: string;
  /** The reader's local day, `YYYY-MM-DD`. */
  date: string;
  title: string;
  generatedAt: string;
  spec: Spec;
  sources: ReportSourceStatus[];
  builtWith: ReportBuiltWith;
}

export interface ReportArchiveEntry {
  date: string;
  title: string;
}

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/** What only the shell knows: the home page's to-dos and recents live in its localStorage. */
export const reportLocalSchema = z.object({
  timezone: z.string().max(80),
  locale: z.string().max(40).default("en-US"),
  name: z.string().max(80).default(""),
  todos: z
    .array(z.object({ id: z.string().max(80), text: z.string().max(240), done: z.boolean(), createdAt: z.number() }))
    .max(50)
    .default([]),
  recents: z
    .array(z.object({ url: z.string().max(2000), title: z.string().max(200), host: z.string().max(120), atMs: z.number(), visits: z.number().default(1) }))
    .max(24)
    .default([]),
});
export type ReportLocal = z.infer<typeof reportLocalSchema>;

export const reportRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("get"), spaceId: z.string().max(120), date: localDate.optional() }),
  z.object({ type: z.literal("generate"), spaceId: z.string().max(120), local: reportLocalSchema }),
  z.object({
    type: z.literal("state"),
    spaceId: z.string().max(120),
    date: localDate,
    changes: z.array(z.object({ path: z.string().max(260), value: z.boolean() })).max(REPORT_LIMITS.stateChanges),
  }),
]);
export type ReportRequest = z.input<typeof reportRequestSchema>;
export type ParsedReportRequest = z.output<typeof reportRequestSchema>;

export interface ReportResponse {
  report: ReportRecord | null;
  /** A generation for this Space is in flight. */
  generating: boolean;
  /** Signed in, so the models are reachable. A brief is still built without them. */
  ai: boolean;
  archive: ReportArchiveEntry[];
}

/**
 * A tick's place in the spec's state. Keys are source ids (`todo:…`, `mail:…`),
 * so they survive a regeneration; anything a JSON pointer would have to escape
 * is flattened, so the path is one plain segment everywhere it travels.
 */
export function tickPath(key: string): string {
  return `/ticks/${key.replace(/[^A-Za-z0-9:_@.-]/gu, "_").slice(0, 200)}`;
}

export function isTickPath(path: string): boolean {
  return /^\/ticks\/[A-Za-z0-9:_@.-]{1,200}$/u.test(path);
}

export function isBriefUrl(value: string): boolean {
  return briefUrlDate(value) !== undefined;
}

/** `null` for today's brief, a date for an archived one, `undefined` when the URL is not a brief. */
export function briefUrlDate(value: string): string | null | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "pistachio:" || url.hostname !== "brief" || url.search !== "" || url.hash !== "") return undefined;
  const path = url.pathname.replace(/^\/+|\/+$/gu, "");
  if (path === "") return null;
  return localDate.safeParse(path).success ? path : undefined;
}

export function briefUrl(date?: string | null): string {
  return date === undefined || date === null ? BRIEF_PAGE_URL : `${BRIEF_PAGE_URL}${date}`;
}
