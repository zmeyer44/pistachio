/**
 * `pistachio://brief/` — the daily brief, drawn by the shell inside the pane
 * like the home page (docs/reports.md). The page is chrome around a report:
 * it asks the host for the day's brief, makes one the first time today's is
 * opened, and hands the spec to `ReportView`. Everything in the report itself
 * comes from the catalog.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronDown, LoaderCircle, RefreshCw } from "lucide-react";
import { profileView } from "@pistachio/shell-contracts/memory";
import { briefUrl, type ReportRecord } from "@pistachio/shell-contracts/reports";
import { HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import { cn } from "../../lib/cn";
import { toggleTodo } from "../../lib/home";
import { briefIsForToday, briefLoadAction, builtWithLine, localDayOf, sourcesLine } from "../../lib/reports";
import { useAppStore } from "../../store";
import { PistachioMark } from "../PistachioMark";
import { useTodos } from "../home/HomeCards";
import { useNow } from "../home/use-now";
import { ReportView } from "./ReportView";
import { ReportOverlayHost } from "./preview";
import { briefKey, useBriefStore } from "./use-brief";

/**
 * The bar above the report. It has no fill of its own: the report's wash runs
 * up behind it (`--report-bleed-top`), so it reads as part of the page. The
 * report steps down by the pane's width (registry.tsx), and the bar with it.
 */
const BAR_HEIGHT = 52;
/** The line that says a brief is an older day's, when there is one: it sits between the bar and the report. */
const STALE_HEIGHT = 32;

const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
/** A quiet word in the bar: it darkens under the pointer and has no box. */
const LINK = cn("flex cursor-pointer items-center gap-1 rounded-full text-[14px] leading-[21px] font-medium text-gray-800 transition-colors hover:text-gray-1000 disabled:cursor-default disabled:opacity-60", FOCUS);
/** The bar's one button: a 30px pill. */
const PILL = cn(
  "flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full bg-alpha-100 px-2.5 text-[14px] leading-[21px] font-medium text-gray-900 transition-colors hover:bg-alpha-200 hover:text-gray-1000 disabled:cursor-default disabled:opacity-60",
  FOCUS,
);
const COLUMN = "mx-auto w-full max-w-[960px] px-4";

/** The report's own outline — cover, tile, title, two columns — at the report's own sizes, so nothing moves when it arrives. */
function Skeleton({ making }: { making: boolean }) {
  const block = "animate-pulse rounded-xl bg-alpha-200";
  return (
    <div data-testid="brief-skeleton" aria-busy="true">
      <div className="mx-auto max-w-[960px] pt-2 @max-[1009px]:max-w-none @max-[1009px]:pt-0">
        <div className={cn(block, "-mx-6 aspect-[3.5/1] rounded-2xl @max-[1009px]:mx-0 @max-[1009px]:rounded-none")} />
      </div>
      <div className={COLUMN}>
        <div className="relative mb-5 -ml-1.5 size-[108px] -mt-[54px] rounded-[30%] bg-background-200 p-1.5 @max-[821px]:mb-4 @max-[821px]:-ml-1 @max-[821px]:size-[88px] @max-[821px]:-mt-[45px] @max-[821px]:p-1 @max-[651px]:size-20 @max-[651px]:-mt-[40px] @max-[451px]:-ml-[3px] @max-[451px]:size-[70px] @max-[451px]:-mt-7 @max-[451px]:p-[3px]">
          <div className="size-full animate-pulse rounded-[29%] bg-gray-400" />
        </div>
        <div className={cn(block, "h-[43px] w-[min(320px,70%)] @max-[821px]:h-[38px] @max-[651px]:h-[34px] @max-[451px]:h-[29px]")} />
        <p className="mt-3 mb-5 text-[16px] leading-6 text-gray-800 @max-[821px]:mb-4 @max-[451px]:text-[14px] @max-[451px]:leading-[21px]">{making ? "Reading your calendar, mail and to-dos…" : "Opening your brief…"}</p>
      </div>
      <hr className="border-0 border-b border-alpha-300" />
      <div className={cn(COLUMN, "flex items-start gap-10 pt-6 pb-10 @max-[1001px]:gap-6 @max-[821px]:flex-col @max-[821px]:items-stretch @max-[821px]:gap-8 @max-[821px]:pt-5 @max-[451px]:pt-4")}>
        <div className="flex min-w-0 flex-1 flex-col gap-4 @max-[821px]:w-full">
          <div className={cn(block, "h-[196px] rounded-2xl")} />
          <div className={cn(block, "h-[112px]")} />
          <div className={cn(block, "h-[112px]")} />
        </div>
        <div className="flex w-[260px] shrink-0 flex-col gap-4 @max-[821px]:grid @max-[821px]:w-full @max-[821px]:grid-cols-2 @max-[561px]:grid-cols-1">
          <div className={cn(block, "h-[132px]")} />
          <div className={cn(block, "h-[116px]")} />
        </div>
      </div>
    </div>
  );
}

function Message({ title, text, action }: { title: string; text: string; action?: { label: string; run: () => void } }) {
  return (
    <div data-testid="brief-message" className="mx-auto flex w-full max-w-[520px] flex-col items-center gap-3 px-4 py-24 text-center @max-[651px]:py-16 @max-[451px]:py-12">
      <PistachioMark size={24} tone="muted" />
      <h1 className="text-[24px] leading-[1.2] font-semibold tracking-[-0.02em] text-balance text-gray-1000 @max-[451px]:text-[20px]">{title}</h1>
      <p className="text-[16px] leading-6 text-pretty text-gray-800 @max-[451px]:text-[14px] @max-[451px]:leading-[21px]">{text}</p>
      {action === undefined ? null : (
        <button type="button" className={cn(PILL, "mt-1")} onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function updatedAt(report: ReportRecord): string {
  return new Date(report.generatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function BriefPage({ tabId, date, active }: { tabId: string | null; date: string | null; active: boolean }) {
  const now = useNow();
  const today = localDayOf(now);
  const day = date ?? today;
  const spaceId = useAppStore((s) => s.snapshot?.activeSpaceId ?? null);
  const navigate = useAppStore((s) => s.navigate);
  const memory = useAppStore((s) => s.memory.entries);
  const name = useMemo(() => profileView(memory, new Date()).name, [memory]);

  const entry = useBriefStore((s) => (spaceId === null ? undefined : s.entries[briefKey(spaceId, day)]));
  const making = useBriefStore((s) => (spaceId === null ? false : s.generating[spaceId] === true));
  const unsupported = useBriefStore((s) => s.unsupported);
  const error = useBriefStore((s) => s.error);
  const todos = useTodos((s) => s.todos);

  const report = entry?.response.report ?? null;
  const archive = entry?.response.archive ?? [];

  // Today's brief makes itself the first time it is opened; an archived day is only ever read.
  useEffect(() => {
    if (spaceId === null) return;
    let cancelled = false;
    void useBriefStore
      .getState()
      .load(spaceId, day)
      .then((response) => {
        if (cancelled || response === null) return;
        // Making it and joining one already under way are the same request: the host runs one at a time.
        if (briefLoadAction(response, date !== null) !== "show") void useBriefStore.getState().generate(spaceId, day, name);
      });
    return () => {
      cancelled = true;
    };
    // `name` only seasons a generation; it must not start one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, day, date]);

  // The home page's to-dos are the truth about to-dos, both ways: finished there is ticked here, reopened there is unticked here.
  const todoTicks = useMemo(() => Object.fromEntries(todos.map((todo) => [`todo:${todo.id}`, todo.done])), [todos]);

  const onTick = (changes: { path: string; value: boolean }[]) => {
    if (spaceId === null || report === null) return;
    for (const change of changes) {
      const id = /^\/ticks\/todo:(.+)$/u.exec(change.path)?.[1];
      if (id === undefined) continue;
      const list = useTodos.getState().todos;
      const todo = list.find((candidate) => candidate.id === id);
      if (todo !== undefined && todo.done !== change.value) useTodos.getState().write(toggleTodo(list, id, Date.now()));
    }
    void useBriefStore.getState().tick(spaceId, report.date, changes);
  };

  const refresh = () => {
    if (spaceId !== null) void useBriefStore.getState().generate(spaceId, today, name);
  };
  const go = (url: string) => {
    if (tabId !== null) void navigate(tabId, url);
  };

  const stale = report !== null && date === null && !briefIsForToday(report, today);
  // Where the report's preview panel is drawn: over the pane, outside what scrolls, inside what the page's steps are measured against.
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  return (
    <div data-testid="brief-page" data-tab-id={tabId ?? undefined} data-active={active} className="@container absolute inset-0 overflow-hidden bg-background-200 text-gray-1000">
      <ReportOverlayHost.Provider value={overlay}>
        <div data-testid="brief-scroll" className="absolute inset-0 overflow-y-auto">
          {/* Edge to edge, whatever the column does, and clear: what shows through it is the report's wash, or on a narrow pane the page. */}
          <nav aria-label="Brief" className="relative z-[1] flex w-full items-center justify-between gap-2 px-4 py-3" style={{ height: BAR_HEIGHT }}>
            <button type="button" className={cn(LINK, "min-w-0 gap-2 text-gray-700")} onClick={() => go(HOME_PAGE_URL)} title="Home">
              <PistachioMark size={20} tone="muted" />
              <span className="truncate text-[15px] tracking-[-0.02em]">Pistachio</span>
            </button>
            <div className="flex shrink-0 items-center gap-4 @max-[451px]:gap-3">
              {report === null ? null : (
                <span data-testid="brief-updated" className="text-[14px] leading-[21px] font-medium text-gray-700 tabular-nums @max-[451px]:hidden">
                  Updated {updatedAt(report)}
                </span>
              )}
              {archive.length <= 1 && date === null ? null : (
                <label className={cn(LINK, "relative focus-within:ring-2 focus-within:ring-ring")}>
                  <span>{date === null ? "Earlier" : day}</span>
                  <ChevronDown className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  <select
                    data-testid="brief-archive"
                    aria-label="Earlier briefs"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    value={date ?? ""}
                    onChange={(event) => go(briefUrl(event.target.value === "" || event.target.value === today ? null : event.target.value))}
                  >
                    <option value="">Today</option>
                    {archive
                      .filter((item) => item.date !== today)
                      .map((item) => (
                        <option key={item.date} value={item.date}>
                          {item.date} — {item.title}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {date !== null ? null : (
                <button type="button" data-testid="brief-refresh" className={PILL} disabled={making || unsupported} onClick={refresh}>
                  {making ? <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" /> : <RefreshCw className="size-3.5" strokeWidth={2} aria-hidden="true" />}
                  Refresh
                </button>
              )}
            </div>
          </nav>

          {unsupported ? (
            <Message title="The brief lives in the desktop app" text="Your daily brief is put together by Pistachio on your computer, from the accounts connected there. Open the desktop app to read it." />
          ) : report !== null ? (
            <>
              {stale ? (
                <p className={cn(COLUMN, "relative z-[1] truncate text-[14px] leading-[21px] text-gray-800")} style={{ height: STALE_HEIGHT }}>
                  This is the brief from {report.date}.{" "}
                  <button type="button" className="cursor-pointer font-medium text-gray-1000 underline" onClick={refresh}>
                    Make today’s
                  </button>
                </p>
              ) : null}
              <div className={cn("transition-opacity", making && "opacity-60")} style={{ "--report-bleed-top": `${String(BAR_HEIGHT + (stale ? STALE_HEIGHT : 0))}px` } as CSSProperties}>
                <ReportView spec={report.spec} revision={`${report.id}@${report.generatedAt}`} ticks={todoTicks} onTick={onTick} />
              </div>
              <footer data-testid="brief-footer" className={cn(COLUMN, "pb-10 text-[13px] leading-relaxed text-pretty text-gray-700 @max-[451px]:pb-8")}>
                {sourcesLine(report.sources)} {builtWithLine(report.builtWith)}
              </footer>
            </>
          ) : making || (entry === undefined && error === null) ? (
            <Skeleton making={making} />
          ) : error !== null ? (
            <Message title="The brief could not be made" text={error} action={{ label: "Try again", run: refresh }} />
          ) : date !== null ? (
            <Message title="No brief for that day" text={`Nothing was made on ${day}. Briefs are kept for a month.`} action={{ label: "Today’s brief", run: () => go(briefUrl()) }} />
          ) : (
            <Skeleton making />
          )}
        </div>
      </ReportOverlayHost.Provider>
      <div ref={setOverlay} className="pointer-events-none absolute inset-0 z-20 [&>*]:pointer-events-auto" />
    </div>
  );
}
