/**
 * The reminders page (pistachio://reminders, ⌘⇧R): a week (the default) or
 * a month of what fired and what is coming, one day's detail with outputs,
 * and the list of every reminder to manage.
 *
 * The week strip needs the page's width for its seven columns, so it sits
 * above the detail; the month grid fits a side rail beside it. A divider
 * between calendar and detail sets how much of the page each takes. The
 * view and both sizes are remembered on this Mac.
 *
 * Rendered by the CHROME renderer over the content hole, the way the
 * settings page is: the tab views sit above the chrome until main raises
 * it, which `overlay: "reminders"` does through the store's overlay
 * reporting. The address is real — typing it in the bar or a tab opening
 * it lands here — but there is no document behind it: the page is a view
 * over main's reminders file, and every change is a request to main.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlarmClock, Bot, CalendarDays, Pause, Pencil, Play, Plus, RotateCcw, Trash2, X, Zap } from "lucide-react";
import {
  calendarItems,
  dayKey,
  describeSchedule,
  formatInstant,
  systemTimezone,
  type CalendarItem,
  type Reminder,
  type ReminderOccurrence,
} from "@pistachio/shell-contracts/reminders";
import { getStoredSplit, MONTH_RAIL, storeSplit, WEEK_STRIP } from "../../lib/calendar-split";
import { cn } from "../../lib/cn";
import { copyFor } from "../../lib/surface-copy";
import { useAppStore } from "../../store";
import { useSurface } from "../../surface";
import { MessageText } from "../MessageText";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Note } from "../ui/note";
import { calendarWindow, dateOf, keyOf, monthOf, startOfWeek, type CalendarView } from "./day-grid";
import { ReminderCalendar } from "./ReminderCalendar";
import { ReminderForm } from "./ReminderForm";
import { ReminderWeek } from "./ReminderWeek";
import { SplitDivider } from "./SplitDivider";
import { dayHeading, KindBadge, relativeTime, StatusBadge, timeOfDay } from "./parts";

const LIST_FILTERS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "finished", label: "Finished" },
] as const;
type ListFilter = (typeof LIST_FILTERS)[number]["value"];

const SOURCE_LABEL = { user: "You", agent: "Agent" } as const;

const VIEW_KEY = "pistachio.reminders.view";

/** The view last chosen on this Mac; the week until one is. */
function storedView(): CalendarView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "month" ? "month" : "week";
  } catch {
    return "week";
  }
}

function storeView(view: CalendarView): void {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // A view that is not remembered is still a view.
  }
}

function ViewSwitch({ view, onChange }: { view: CalendarView; onChange(view: CalendarView): void }) {
  return (
    <div role="tablist" aria-label="Calendar view" className="ml-2 flex items-center rounded-full bg-alpha-100 p-0.5">
      {(["week", "month"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={view === option}
          data-testid={`calendar-view-${option}`}
          onClick={() => onChange(option)}
          className={cn(
            "h-6 cursor-pointer rounded-full px-2.5 text-label-12 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            view === option ? "bg-background-100 text-gray-1000 shadow-border" : "text-gray-900 hover:text-gray-1000",
          )}
        >
          {option === "week" ? "Week" : "Month"}
        </button>
      ))}
    </div>
  );
}

export function RemindersPage() {
  const snapshot = useAppStore((state) => state.reminders);
  const loaded = useAppStore((state) => state.remindersLoaded);
  const focus = useAppStore((state) => state.remindersFocus);
  const closeReminders = useAppStore((state) => state.closeReminders);
  const timezone = useMemo(systemTimezone, []);
  const [now, setNow] = useState(() => new Date());
  const today = keyOf(now);
  const focused = useMemo(
    () => (focus === null ? null : (snapshot.occurrences.find((occurrence) => occurrence.id === focus) ?? null)),
    [focus, snapshot.occurrences],
  );
  const [selected, setSelected] = useState<string>(() => (focused === null ? today : dayKey(focused.scheduledFor, timezone)));
  const [view, setView] = useState<CalendarView>(storedView);
  /** The day the calendar is turned to: its week in week view, its month in month view. */
  const [anchor, setAnchor] = useState<Date>(() => dateOf(selected));
  const [form, setForm] = useState<{ open: false } | { open: true; reminder: Reminder | null }>({ open: false });
  const [filter, setFilter] = useState<ListFilter>("active");
  // How much of the page the calendar takes, in each view.
  const [weekHeight, setWeekHeight] = useState(() => getStoredSplit(WEEK_STRIP));
  const [monthWidth, setMonthWidth] = useState(() => getStoredSplit(MONTH_RAIL));
  const stripRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);

  // Relative times ("in 20 min") drift; a minute is fine for a page.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (form.open) setForm({ open: false });
      else closeReminders();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeReminders, form.open]);

  // Landing on an occurrence from a console card: its day, scrolled to it.
  useEffect(() => {
    if (focused === null) return;
    const key = dayKey(focused.scheduledFor, timezone);
    setSelected(key);
    setAnchor(dateOf(key));
    const frame = requestAnimationFrame(() => {
      document.getElementById(`occurrence-${focused.id}`)?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focused, timezone]);

  const items = useMemo(() => {
    const { from, to } = calendarWindow(view, anchor);
    return calendarItems(snapshot, from, to, timezone);
  }, [snapshot, view, anchor, timezone]);

  const changeView = (next: CalendarView) => {
    setView(next);
    storeView(next);
    // Whichever view opens, it opens on the selected day.
    setAnchor(dateOf(selected));
  };
  const switcher = <ViewSwitch view={view} onChange={changeView} />;
  const legend = (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-700">
      <Legend className="bg-background-100 shadow-border">Upcoming</Legend>
      <Legend className="bg-green-100">Done</Legend>
      <Legend className="bg-amber-100">Missed</Legend>
      <Legend className="bg-red-100">Failed</Legend>
    </p>
  );

  const copy = copyFor(useSurface().kind).reminders;
  const active = snapshot.reminders.filter((reminder) => reminder.status === "active").length;
  const waiting = snapshot.occurrences.filter((occurrence) => occurrence.status === "queued" || occurrence.status === "running").length;

  return (
    <div
      role="dialog"
      aria-label="Reminders"
      data-testid="reminders-page"
      className="@container animate-backdrop-in absolute inset-0 z-20 flex flex-col overflow-hidden rounded-md bg-background-100 shadow-small"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-alpha-400 px-5 py-3 @max-md:px-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-gray-100 text-gray-1000 shadow-border">
          <AlarmClock className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-heading-16 text-gray-1000">Reminders</h1>
          <p className="truncate text-label-12 text-gray-700">
            {loaded
              ? `${String(active)} scheduled${waiting > 0 ? ` · ${String(waiting)} waiting for the agent` : ""} · ${copy.scope}`
              : "Loading…"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {form.open ? null : (
            <Button size="sm" prefix={<Plus aria-hidden="true" />} onClick={() => setForm({ open: true, reminder: null })} data-testid="new-reminder">
              New reminder
            </Button>
          )}
          <Kbd className="@max-md:hidden">esc</Kbd>
          <Button variant="tertiary" size="sm" svgOnly aria-label="Close reminders" onClick={closeReminders}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div className={cn("flex min-h-0 flex-1", view === "week" ? "flex-col overflow-y-auto scroll-thin" : "@max-3xl:flex-col @max-3xl:overflow-y-auto")}>
        {view === "week" ? (
          <section
            ref={stripRef}
            style={{ height: weekHeight }}
            className="flex shrink-0 flex-col border-b border-alpha-400 bg-background-200 p-4 @max-md:p-3"
            aria-label="This week"
          >
            <ReminderWeek
              weekStart={startOfWeek(anchor)}
              selected={selected}
              today={today}
              items={items}
              timezone={timezone}
              onSelect={setSelected}
              onWeek={setAnchor}
              trailing={switcher}
            />
            {legend}
          </section>
        ) : (
          <aside
            ref={railRef}
            style={{ "--rail-w": `${String(monthWidth)}px` } as React.CSSProperties}
            className="scroll-thin w-(--rail-w) shrink-0 overflow-y-auto border-r border-alpha-400 bg-background-200 p-4 @max-3xl:w-auto @max-3xl:overflow-visible @max-3xl:border-r-0 @max-3xl:border-b"
          >
            <ReminderCalendar
              month={monthOf(anchor)}
              selected={selected}
              today={today}
              items={items}
              onSelect={setSelected}
              onMonth={(next) => setAnchor(new Date(next.year, next.month - 1, 1))}
              trailing={switcher}
            />
            {legend}
          </aside>
        )}
        {view === "week" ? (
          <SplitDivider
            orientation="horizontal"
            value={weekHeight}
            min={WEEK_STRIP.min}
            max={WEEK_STRIP.max}
            defaultValue={WEEK_STRIP.default}
            label="Resize the week calendar"
            paneRef={stripRef}
            onChange={(px) => setWeekHeight(storeSplit(WEEK_STRIP, px))}
          />
        ) : (
          // Stacked (a narrow pane), the rail is full-width and there is no edge to drag.
          <SplitDivider
            orientation="vertical"
            value={monthWidth}
            min={MONTH_RAIL.min}
            max={MONTH_RAIL.max}
            defaultValue={MONTH_RAIL.default}
            label="Resize the month calendar"
            paneRef={railRef}
            onChange={(px) => setMonthWidth(storeSplit(MONTH_RAIL, px))}
            className="@max-3xl:hidden"
          />
        )}
        <main className={cn("min-w-0 flex-1 p-5 @max-md:p-3", view === "week" ? "" : "scroll-thin overflow-y-auto @max-3xl:overflow-visible")}>
          <div className="mx-auto flex max-w-180 flex-col gap-5">
            {form.open ? (
              <ReminderForm key={form.reminder?.id ?? "new"} reminder={form.reminder} onDone={() => setForm({ open: false })} />
            ) : null}
            <DayDetail
              day={selected}
              today={today}
              items={items.get(selected) ?? []}
              now={now}
              timezone={timezone}
              focusId={focused?.id ?? null}
              onEdit={(reminder) => setForm({ open: true, reminder })}
            />
            <AllReminders
              reminders={snapshot.reminders}
              filter={filter}
              setFilter={setFilter}
              now={now}
              onEdit={(reminder) => setForm({ open: true, reminder })}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

function Legend({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("inline-block size-2.5 rounded-xs", className)} />
      {children}
    </span>
  );
}

/* ------------------------------ day detail ------------------------------ */

function DayDetail({
  day,
  today,
  items,
  now,
  timezone,
  focusId,
  onEdit,
}: {
  day: string;
  today: string;
  items: CalendarItem[];
  now: Date;
  timezone: string;
  focusId: string | null;
  onEdit(reminder: Reminder): void;
}) {
  return (
    <section aria-label={`Reminders on ${dayHeading(day)}`} data-testid="reminder-day">
      <header className="mb-3 flex items-center gap-2">
        <CalendarDays className="size-4 text-gray-700" aria-hidden="true" />
        <h2 className="text-heading-16 text-gray-1000">{dayHeading(day)}</h2>
        {day === today ? (
          <Badge variant="inverted" size="sm">
            Today
          </Badge>
        ) : null}
      </header>
      {items.length === 0 ? (
        <Note type="secondary" size="sm">
          Nothing on this day. Ask the agent — “remind me tomorrow at 9 to…” — or add one with New reminder.
        </Note>
      ) : (
        <ol className="grid gap-2">
          {items.map((item) =>
            item.kind === "upcoming" ? (
              <UpcomingRow key={`up:${item.reminder.id}:${item.at}`} item={item} now={now} timezone={timezone} onEdit={onEdit} />
            ) : (
              <OccurrenceRow key={item.occurrence.id} occurrence={item.occurrence} reminder={item.reminder} now={now} timezone={timezone} focused={item.occurrence.id === focusId} onEdit={onEdit} />
            ),
          )}
        </ol>
      )}
    </section>
  );
}

function UpcomingRow({
  item,
  now,
  timezone,
  onEdit,
}: {
  item: Extract<CalendarItem, { kind: "upcoming" }>;
  now: Date;
  timezone: string;
  onEdit(reminder: Reminder): void;
}) {
  const runReminderNow = useAppStore((state) => state.runReminderNow);
  const { reminder } = item;
  return (
    <li className="grid grid-cols-[56px_1fr] gap-3 rounded-md border border-dashed border-alpha-500 bg-background-100 px-3 py-2.5">
      <span className="pt-0.5 text-label-12 tabular-nums text-gray-900">{timeOfDay(item.at, timezone)}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong className="min-w-0 truncate text-label-13 font-medium text-gray-1000">{reminder.title}</strong>
          <KindBadge kind={reminder.action.kind} />
          <span className="text-[11px] text-gray-700">{relativeTime(item.at, now)}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-copy-13 text-gray-900">
          {reminder.action.kind === "message" ? reminder.action.text : reminder.action.prompt}
        </p>
        <div className="mt-1.5 flex items-center gap-1">
          <Button variant="tertiary" size="xs" prefix={<Pencil aria-hidden="true" />} onClick={() => onEdit(reminder)}>
            Edit
          </Button>
          <Button variant="tertiary" size="xs" prefix={<Zap aria-hidden="true" />} onClick={() => void runReminderNow(reminder.id)}>
            Run now
          </Button>
        </div>
      </div>
    </li>
  );
}

function OccurrenceRow({
  occurrence,
  reminder,
  now,
  timezone,
  focused,
  onEdit,
}: {
  occurrence: ReminderOccurrence;
  reminder: Reminder | null;
  now: Date;
  timezone: string;
  focused: boolean;
  onEdit(reminder: Reminder): void;
}) {
  const acknowledge = useAppStore((state) => state.acknowledgeReminders);
  const snooze = useAppStore((state) => state.snoozeReminder);
  const [expanded, setExpanded] = useState(focused);
  const body = occurrence.output ?? occurrence.error;
  const settled = occurrence.status !== "queued" && occurrence.status !== "running";
  const long = (body ?? "").length > 280;
  return (
    <li
      id={`occurrence-${occurrence.id}`}
      data-testid="reminder-occurrence"
      data-status={occurrence.status}
      className={cn(
        "grid grid-cols-[56px_1fr] gap-3 rounded-md bg-background-100 px-3 py-2.5 shadow-border",
        focused && "ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
    >
      <span className="pt-0.5 text-label-12 tabular-nums text-gray-900">{timeOfDay(occurrence.scheduledFor, timezone)}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong className="min-w-0 truncate text-label-13 font-medium text-gray-1000">{occurrence.title}</strong>
          <KindBadge kind={occurrence.actionKind} />
          <StatusBadge status={occurrence.status} />
          {occurrence.finishedAt === null ? null : <span className="text-[11px] text-gray-700">{relativeTime(occurrence.finishedAt, now)}</span>}
        </div>
        {body === null ? null : (
          <div className="mt-1">
            <p
              className={cn(
                "text-copy-13 wrap-anywhere whitespace-pre-wrap",
                occurrence.status === "failed" || occurrence.status === "missed" ? "text-gray-900" : "text-gray-1000",
                !expanded && "line-clamp-4",
              )}
            >
              <MessageText text={body} links="tab" />
            </p>
            {long ? (
              <button type="button" className="mt-1 cursor-pointer text-label-12 font-medium text-gray-900 hover:text-gray-1000" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show less" : "Show all"}
              </button>
            ) : null}
          </div>
        )}
        {settled ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {occurrence.acknowledgedAt === null ? (
              <Button variant="tertiary" size="xs" onClick={() => void acknowledge([occurrence.id])}>
                Dismiss
              </Button>
            ) : null}
            {reminder === null ? null : (
              <>
                <Button variant="tertiary" size="xs" prefix={<RotateCcw aria-hidden="true" />} onClick={() => void snooze(occurrence.id, 10)}>
                  Again in 10 min
                </Button>
                <Button variant="tertiary" size="xs" prefix={<Pencil aria-hidden="true" />} onClick={() => onEdit(reminder)}>
                  Edit reminder
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/* ------------------------------- the list ------------------------------- */

function AllReminders({
  reminders,
  filter,
  setFilter,
  now,
  onEdit,
}: {
  reminders: Reminder[];
  filter: ListFilter;
  setFilter(filter: ListFilter): void;
  now: Date;
  onEdit(reminder: Reminder): void;
}) {
  const rows = useMemo(
    () =>
      reminders
        .filter((reminder) =>
          filter === "active" ? reminder.status === "active" : filter === "paused" ? reminder.status === "paused" : reminder.status === "done" || reminder.status === "cancelled",
        )
        .sort((a, b) => {
          const an = a.nextFireAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.nextFireAt);
          const bn = b.nextFireAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.nextFireAt);
          return an - bn || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        }),
    [reminders, filter],
  );
  return (
    <section aria-label="All reminders" data-testid="reminder-list" className="overflow-hidden rounded-md bg-background-100 shadow-border">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <h2 className="text-heading-14 text-gray-1000">All reminders</h2>
        <div role="tablist" aria-label="Filter reminders" className="ml-auto flex items-center gap-1">
          {LIST_FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={filter === item.value}
              onClick={() => setFilter(item.value)}
              className={cn(
                "h-7 cursor-pointer rounded-full px-3 text-label-12 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                filter === item.value ? "bg-gray-1000 text-background-100" : "text-gray-900 hover:bg-alpha-100 hover:text-gray-1000",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="border-t border-alpha-400 px-4 py-3">
          <Note type="secondary" size="sm">
            {filter === "active" ? "Nothing scheduled." : filter === "paused" ? "Nothing is paused." : "Nothing has finished yet."}
          </Note>
        </div>
      ) : (
        <ul className="divide-y divide-alpha-400 border-t border-alpha-400">
          {rows.map((reminder) => (
            <ReminderRow key={reminder.id} reminder={reminder} now={now} onEdit={onEdit} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReminderRow({ reminder, now, onEdit }: { reminder: Reminder; now: Date; onEdit(reminder: Reminder): void }) {
  const updateReminder = useAppStore((state) => state.updateReminder);
  const cancelReminder = useAppStore((state) => state.cancelReminder);
  const deleteReminder = useAppStore((state) => state.deleteReminder);
  const runReminderNow = useAppStore((state) => state.runReminderNow);
  const live = reminder.status === "active" || reminder.status === "paused";
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3" data-testid="reminder-row" data-status={reminder.status}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong className="min-w-0 truncate text-label-13 font-medium text-gray-1000">{reminder.title}</strong>
          <KindBadge kind={reminder.action.kind} />
          {reminder.status === "paused" ? (
            <Badge variant="amber-subtle" size="sm">
              Paused
            </Badge>
          ) : reminder.status === "done" ? (
            <Badge variant="gray-subtle" size="sm">
              Finished
            </Badge>
          ) : reminder.status === "cancelled" ? (
            <Badge variant="gray-subtle" size="sm">
              Cancelled
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-label-12 text-gray-900">
          <span>{describeSchedule(reminder.schedule, reminder.timezone)}</span>
          {reminder.nextFireAt === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span>
                Next {formatInstant(reminder.nextFireAt, reminder.timezone)} ({relativeTime(reminder.nextFireAt, now)})
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            {reminder.source.kind === "agent" ? <Bot className="size-3" aria-hidden="true" /> : null}
            {SOURCE_LABEL[reminder.source.kind]}
          </span>
          {reminder.fireCount > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                Fired {reminder.fireCount} {reminder.fireCount === 1 ? "time" : "times"}
              </span>
            </>
          ) : null}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-0.5">
        {live ? (
          <>
            <Button variant="tertiary" size="xs" svgOnly title="Run now" aria-label={`Run ${reminder.title} now`} onClick={() => void runReminderNow(reminder.id)}>
              <Zap aria-hidden="true" />
            </Button>
            <Button
              variant="tertiary"
              size="xs"
              svgOnly
              title={reminder.status === "paused" ? "Resume" : "Pause"}
              aria-label={`${reminder.status === "paused" ? "Resume" : "Pause"} ${reminder.title}`}
              onClick={() => void updateReminder(reminder.id, { status: reminder.status === "paused" ? "active" : "paused" })}
            >
              {reminder.status === "paused" ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            </Button>
            <Button variant="tertiary" size="xs" svgOnly title="Edit" aria-label={`Edit ${reminder.title}`} onClick={() => onEdit(reminder)}>
              <Pencil aria-hidden="true" />
            </Button>
            <Button variant="tertiary" size="xs" svgOnly title="Cancel" aria-label={`Cancel ${reminder.title}`} onClick={() => void cancelReminder(reminder.id)}>
              <X aria-hidden="true" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="tertiary" size="xs" svgOnly title="Schedule again" aria-label={`Schedule ${reminder.title} again`} onClick={() => onEdit(reminder)}>
              <RotateCcw aria-hidden="true" />
            </Button>
            <Button
              variant="tertiary"
              size="xs"
              svgOnly
              title="Delete"
              aria-label={`Delete ${reminder.title}`}
              onClick={() => {
                if (window.confirm(`Delete “${reminder.title}” and its history?`)) void deleteReminder(reminder.id);
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </>
        )}
      </span>
    </li>
  );
}
