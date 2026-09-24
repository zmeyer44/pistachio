/**
 * The daily brief on this Mac (docs/reports.md): gather the person's own
 * material, hand it to the pure pipeline in `@pistachio/reports`, keep what
 * comes back.
 *
 * Gathering is the only thing here that touches the world, and every source
 * degrades on its own: no calendar is a brief without a schedule, never a
 * failed brief. One brief per Space per local day, regenerated in place, with
 * the last month kept — under `<userData>/briefs/`, readable only by the
 * person's account, because a brief quotes their mail.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Experimental_EvaluationModel, LanguageModel } from "ai";
import { calendarItems, unacknowledgedOccurrences, type ReminderSnapshot } from "@pistachio/shell-contracts/reminders";
import type { CalendarAgenda } from "@pistachio/shell-contracts/ipc";
import type { WatchtowerRequest, WatchtowerResponse, WatchtowerSettings } from "@pistachio/shell-contracts/watchtower";
import {
  REPORT_LIMITS,
  isTickPath,
  reportLocalSchema,
  reportRequestSchema,
  type ParsedReportRequest,
  type ReportArchiveEntry,
  type ReportLocal,
  type ReportRecord,
  type ReportResponse,
  type ReportSourceState,
  type ReportSourceStatus,
} from "@pistachio/reports/contract";
import { generateBrief } from "@pistachio/reports/brief/generate";
import { briefTitle, localDay, sortEvents, type BriefMaterials, type BriefPage, type BriefThread } from "@pistachio/reports/brief/materials";
import { validateReportSpec } from "@pistachio/reports/validate";
import type { MailDigest } from "./account/integration-service";

export interface BriefServiceDeps {
  userDataDir: string;
  enrolled: () => boolean;
  calendar: (spaceId: string, from: string, to: string) => Promise<CalendarAgenda>;
  mail: (spaceId: string) => Promise<MailDigest>;
  reminders: () => ReminderSnapshot;
  watchtower: { settings(): WatchtowerSettings; request(spaceId: string, request: WatchtowerRequest): Promise<WatchtowerResponse> } | null;
  threads: (spaceId: string) => BriefThread[];
  decide: () => { id: string; model: Experimental_EvaluationModel } | null;
  write: () => { id: string; model: LanguageModel } | null;
  /** E2E: a whole day's materials, so a spec needs neither an account nor a network. */
  scripted?: () => Partial<BriefMaterials> | null;
  /** Every brief that was made and filed, however it was asked for. */
  onGenerated?: (record: ReportRecord) => void;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

/** How long one source may take before the brief goes on without it. */
const SOURCE_DEADLINE_MS = 12_000;

function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), SOURCE_DEADLINE_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function sourceState(status: CalendarAgenda["status"], count: number): ReportSourceState {
  return status === "ok" && count === 0 ? "empty" : status;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/** Milliseconds of the local day already gone at `at`, read off the zone's own wall clock. */
function elapsedInLocalDay(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(at));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return ((pick("hour") % 24) * 3600 + pick("minute") * 60 + pick("second")) * 1000 + (((at % 1000) + 1000) % 1000);
}

/**
 * The instant the local day holding `at` began. The wall clock says how much
 * of the day has gone, which is wrong by the shift on a day the clocks change —
 * so the guess is read back and corrected until it lands on 00:00:00.000 of
 * the same day (twice at most; a zone whose midnight does not exist that day
 * settles on the first instant that does).
 */
export function startOfLocalDay(at: number, timezone: string): number {
  const day = localDay(new Date(at), timezone);
  let guess = at - elapsedInLocalDay(at, timezone);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const elapsed = elapsedInLocalDay(guess, timezone);
    const sameDay = localDay(new Date(guess), timezone) === day;
    if (sameDay && elapsed === 0) break;
    guess += sameDay ? -elapsed : 86_400_000 - elapsed;
  }
  return guess;
}

/** The reader's local day as instants: this midnight to the next, exactly — a day is 23 or 25 hours when the clocks change. */
export function dayWindow(now: Date, timezone: string): { from: string; to: string } {
  const from = startOfLocalDay(now.getTime(), timezone);
  const to = startOfLocalDay(from + 36 * 3_600_000, timezone);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export class BriefService {
  readonly #deps: BriefServiceDeps;
  readonly #dir: string;
  readonly #inFlight = new Map<string, Promise<ReportRecord>>();

  constructor(deps: BriefServiceDeps) {
    this.#deps = deps;
    this.#dir = join(deps.userDataDir, "briefs");
  }

  async handle(value: unknown): Promise<ReportResponse> {
    const request: ParsedReportRequest = reportRequestSchema.parse(value);
    const now = this.#now();
    if (request.type === "generate") {
      this.#rememberLocal(request.local);
      const report = await this.generate(request.spaceId, request.local);
      return this.#respond(request.spaceId, report);
    }
    if (request.type === "state") {
      const report = this.#read(request.spaceId, request.date);
      if (report !== null) {
        const state = (report.spec.state ?? {}) as { ticks?: Record<string, boolean> };
        const ticks = { ...state.ticks };
        for (const change of request.changes) {
          if (!isTickPath(change.path)) continue;
          const key = change.path.slice("/ticks/".length);
          if (change.value) ticks[key] = true;
          else delete ticks[key];
        }
        report.spec.state = { ...state, ticks };
        this.#write(report);
      }
      return this.#respond(request.spaceId, report);
    }
    // `get` without a date is "today", in the zone the last brief was made in — the shell sends a date once it knows one.
    const date = request.date ?? localDay(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
    return this.#respond(request.spaceId, this.#read(request.spaceId, date));
  }

  /** One generation per Space at a time; a second caller joins the first. */
  generate(spaceId: string, local: ReportLocal): Promise<ReportRecord> {
    const running = this.#inFlight.get(spaceId);
    if (running !== undefined) return running;
    const work = this.#generate(spaceId, local).finally(() => this.#inFlight.delete(spaceId));
    this.#inFlight.set(spaceId, work);
    return work;
  }

  generating(spaceId: string): boolean {
    return this.#inFlight.has(spaceId);
  }

  has(spaceId: string, date: string): boolean {
    return this.#read(spaceId, date) !== null;
  }

  /**
   * A brief made with no shell to ask (the morning schedule, no window open):
   * the to-dos and recents are the ones a shell last sent, which may be a day
   * old — better than a brief with no to-dos, and the next refresh corrects it.
   */
  generateFromLastLocal(spaceId: string): Promise<ReportRecord> {
    return this.generate(spaceId, this.#lastLocal());
  }

  #lastLocal(): ReportLocal {
    const fallback = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: "en-US", name: "", todos: [], recents: [] };
    try {
      const parsed = reportLocalSchema.safeParse(JSON.parse(readFileSync(join(this.#dir, "local.json"), "utf8")));
      return parsed.success ? parsed.data : fallback;
    } catch {
      return fallback;
    }
  }

  #rememberLocal(local: ReportLocal): void {
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.#dir, "local.json.tmp"), JSON.stringify(local), { mode: 0o600 });
      renameSync(join(this.#dir, "local.json.tmp"), join(this.#dir, "local.json"));
    } catch (error) {
      this.#deps.onError?.(error);
    }
  }

  async #generate(spaceId: string, local: ReportLocal): Promise<ReportRecord> {
    const now = this.#now();
    const materials = await this.gather(spaceId, local, now);
    const brief = await generateBrief(materials, {
      decide: this.#deps.decide(),
      write: this.#deps.write(),
      ...(this.#deps.onError === undefined ? {} : { onError: this.#deps.onError }),
    });
    const date = localDay(now, materials.timezone);
    // Ticks outlive a regeneration: they are keyed by source id, not by position.
    const previous = this.#read(spaceId, date);
    const kept = ((previous?.spec.state ?? {}) as { ticks?: Record<string, boolean> }).ticks ?? {};
    brief.spec.state = { ...(brief.spec.state ?? {}), ticks: kept };
    const record: ReportRecord = {
      id: `brief:${spaceId}:${date}`,
      kind: "daily_brief",
      spaceId,
      date,
      title: brief.title,
      generatedAt: now.toISOString(),
      spec: brief.spec,
      sources: materials.sources,
      builtWith: brief.builtWith,
    };
    this.#write(record);
    this.#prune(spaceId);
    this.#deps.onGenerated?.(record);
    return record;
  }

  /** Every source, side by side, each allowed to fail alone. */
  async gather(spaceId: string, local: ReportLocal, now: Date): Promise<BriefMaterials> {
    const base: BriefMaterials = {
      now: now.toISOString(),
      timezone: local.timezone,
      locale: local.locale,
      name: local.name,
      events: [],
      messages: [],
      reminders: [],
      todos: local.todos.filter((todo) => !todo.done).map((todo) => ({ id: todo.id, text: todo.text, createdAt: todo.createdAt })),
      pages: [],
      threads: [],
      sources: [],
      pagesShareable: false,
    };
    const scripted = this.#deps.scripted?.() ?? null;
    if (scripted !== null) return { ...base, ...scripted, now: scripted.now ?? base.now, timezone: scripted.timezone ?? base.timezone };

    const window = dayWindow(now, local.timezone);
    const unreachable = { status: "unreachable" as const, connectable: false, accountLabel: null };
    const [agenda, digest, pages] = await Promise.all([
      within(this.#deps.calendar(spaceId, window.from, window.to), { ...unreachable, events: [] }),
      within(this.#deps.mail(spaceId), { ...unreachable, messages: [] }),
      within(this.#pages(spaceId, now), null),
    ]);

    const snapshot = this.#deps.reminders();
    const upcoming = [...calendarItems(snapshot, new Date(window.from), new Date(window.to), local.timezone).values()]
      .flat()
      .filter((item) => item.kind === "upcoming" && new Date(item.at).getTime() > now.getTime())
      .map((item) => ({ id: item.reminder?.id ?? item.at, title: item.reminder?.title ?? "Reminder", at: item.at, state: "upcoming" as const }));
    const fired = unacknowledgedOccurrences(snapshot).map((occurrence) => ({
      id: occurrence.id,
      title: occurrence.title,
      at: occurrence.scheduledFor,
      state: occurrence.status === "missed" ? ("missed" as const) : ("unread" as const),
    }));
    const threads = this.#deps.threads(spaceId).slice(0, REPORT_LIMITS.threads);

    // With the archive off, the home page's own recents are what the person was reading.
    const recents: BriefPage[] = local.recents
      .filter((recent) => now.getTime() - recent.atMs < 3 * 86_400_000)
      .sort((a, b) => b.atMs - a.atMs)
      .map((recent) => ({ url: recent.url, title: recent.title, host: recent.host, visitedAt: recent.atMs, snippet: "", kind: "page" as const }));

    const sources: ReportSourceStatus[] = [
      { source: "calendar", state: sourceState(agenda.status, agenda.events.length), connectable: agenda.connectable, accountLabel: agenda.accountLabel, count: agenda.events.length },
      { source: "gmail", state: sourceState(digest.status, digest.messages.length), connectable: digest.connectable, accountLabel: digest.accountLabel, count: digest.messages.length },
      { source: "reminders", state: upcoming.length + fired.length === 0 ? "empty" : "ok", connectable: false, accountLabel: null, count: upcoming.length + fired.length },
      { source: "todos", state: base.todos.length === 0 ? "empty" : "ok", connectable: false, accountLabel: null, count: base.todos.length },
      { source: "watchtower", state: pages === null ? "off" : pages.length === 0 ? "empty" : "ok", connectable: false, accountLabel: null, count: pages?.length ?? 0 },
      { source: "threads", state: threads.length === 0 ? "empty" : "ok", connectable: false, accountLabel: null, count: threads.length },
    ];
    return {
      ...base,
      // Each calendar answered in its own order; the day is one list, so sort before anything is cut off.
      events: sortEvents(agenda.events).slice(0, REPORT_LIMITS.events),
      messages: digest.messages.slice(0, REPORT_LIMITS.messages),
      reminders: [...upcoming, ...fired].slice(0, REPORT_LIMITS.reminders * 2),
      pages: (pages !== null && pages.length > 0 ? pages : recents).slice(0, REPORT_LIMITS.pages),
      threads,
      sources,
      // The archive's words reach a model only when its own "agent access" switch allows it.
      pagesShareable: pages !== null && pages.length > 0 && (this.#deps.watchtower?.settings().agentAccess ?? false),
    };
  }

  /** Articles and videos from the last two days of the archive; null when the archive is off. */
  async #pages(spaceId: string, now: Date): Promise<BriefPage[] | null> {
    const archive = this.#deps.watchtower;
    if (archive === null || !archive.settings().enabled) return null;
    const since = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    const response = await archive.request(spaceId, { type: "search", query: `after:${since}`, limit: 50 });
    const seen = new Set<string>();
    const pages: BriefPage[] = [];
    for (const hit of [...(response.results ?? [])].sort((a, b) => b.visitedAt - a.visitedAt)) {
      // Reading, not navigating: an index page or a search result is not something to pick back up.
      if (hit.kind === "page" || hit.coverage === "metadata" || hit.coverage === "expired") continue;
      const key = hit.url.replace(/[#?].*$/u, "");
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push({ url: hit.url, title: hit.title, host: hostOf(hit.url), visitedAt: hit.visitedAt, snippet: hit.snippet, kind: hit.kind });
    }
    return pages;
  }

  // -------------------------------------------------------------------------
  // The shelf

  #respond(spaceId: string, report: ReportRecord | null): ReportResponse {
    return { report, generating: this.generating(spaceId), ai: this.#deps.enrolled(), archive: this.#archive(spaceId) };
  }

  #file(spaceId: string, date: string): string {
    return join(this.#dir, `${encodeURIComponent(spaceId)}__${date}.json`);
  }

  #read(spaceId: string, date: string): ReportRecord | null {
    try {
      const record = JSON.parse(readFileSync(this.#file(spaceId, date), "utf8")) as ReportRecord;
      // A file is only as trusted as anything else on disk: it is checked like a fresh composition.
      if (record.kind !== "daily_brief" || record.spaceId !== spaceId || record.date !== date || !validateReportSpec(record.spec).ok) return null;
      return record;
    } catch {
      return null;
    }
  }

  #write(record: ReportRecord): void {
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const path = this.#file(record.spaceId, record.date);
      writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      this.#deps.onError?.(error);
    }
  }

  #dates(spaceId: string): string[] {
    const prefix = `${encodeURIComponent(spaceId)}__`;
    try {
      return readdirSync(this.#dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
        .map((name) => name.slice(prefix.length, -".json".length))
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Named from the date alone — "The Monday Brief" — so listing a month of briefs opens none of them. */
  #archive(spaceId: string): ReportArchiveEntry[] {
    return this.#dates(spaceId)
      .slice(0, REPORT_LIMITS.archiveDays)
      .map((date) => ({ date, title: briefTitle(new Date(`${date}T12:00:00Z`), { locale: "en-US", timezone: "UTC" }) }));
  }

  #prune(spaceId: string): void {
    for (const date of this.#dates(spaceId).slice(REPORT_LIMITS.archiveDays)) rmSync(this.#file(spaceId, date), { force: true });
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }
}

/** `PISTACHIO_BRIEF_SCRIPT` — a day's materials as JSON, honoured only under `PISTACHIO_E2E=1`. */
export function scriptedBriefMaterials(env: NodeJS.ProcessEnv = process.env): Partial<BriefMaterials> | null {
  if (env["PISTACHIO_E2E"] !== "1") return null;
  const raw = env["PISTACHIO_BRIEF_SCRIPT"];
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<BriefMaterials>) : null;
  } catch {
    return null;
  }
}
