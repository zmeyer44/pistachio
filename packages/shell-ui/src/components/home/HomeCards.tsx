import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarDays, Check, Plus, Video, X } from "lucide-react";
import { create } from "zustand";
import { systemTimezone } from "@pistachio/shell-contracts/reminders";
import { cn } from "../../lib/cn";
import {
  addTodo,
  browsableRecents,
  eventAgenda,
  loadTodos,
  mergeAgenda,
  MAX_TODO_TEXT,
  orderedTodos,
  parseTodos,
  relativeTime,
  removeTodo,
  saveTodos,
  showsCalendarPrompt,
  startOfDay,
  todayAgenda,
  toggleTodo,
  type HomeTodo,
} from "../../lib/home";
import { useAppStore } from "../../store";
import type { HomeNavigation } from "./navigation";
import { CardNote, HomeCard, SiteIcon } from "./parts";
import { useCalendarAgenda, useCalendarAgendaStore } from "./use-calendar-agenda";

const RECENT_ROWS = 4;
const RECENT_ROWS_ALL = 8;
const AGENDA_ROWS = 6;

const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/* --------------------------- continue browsing --------------------------- */

/** The pages visited last, newest first — the recents the address modal keeps (lib/recents.ts). */
export function ContinueBrowsing({ navigation, now }: { navigation: HomeNavigation; now: Date }) {
  const recents = useAppStore((s) => s.recents);
  const remembering = useAppStore((s) => s.settings.privacy.rememberRecents);
  const [all, setAll] = useState(false);
  const sites = useMemo(() => browsableRecents(recents), [recents]);
  const shown = sites.slice(0, all ? RECENT_ROWS_ALL : RECENT_ROWS);

  return (
    <HomeCard
      testId="home-recents"
      title="Continue browsing"
      action={
        sites.length > RECENT_ROWS ? (
          <button
            type="button"
            onClick={() => setAll((value) => !value)}
            className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] text-gray-800 hover:bg-alpha-100 hover:text-gray-1000"
          >
            {all ? "Show less" : "See all"}
            <ArrowRight className={cn("size-3.5 transition-transform duration-150", all && "-rotate-90")} aria-hidden="true" />
          </button>
        ) : null
      }
    >
      {shown.length === 0 ? (
        <CardNote>
          {remembering
            ? "Sites you visit show up here, so you can pick up where you left off."
            : "Recent sites are turned off in Settings → Privacy."}
        </CardNote>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {shown.map((site) => (
            <li key={site.host}>
              <button
                type="button"
                data-testid="home-recent"
                onClick={() => navigation.open(site.url)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors duration-100 hover:bg-alpha-100"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-background-100 shadow-[0_0_0_1px_var(--color-alpha-300)]">
                  <SiteIcon url={site.url} faviconUrl={site.faviconUrl} label={site.host} className="size-5 rounded text-[11px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-gray-1000">{site.title || site.host}</span>
                  <span className="block truncate text-[12px] text-gray-700">{site.host.replace(/^www\./iu, "")}</span>
                </span>
                <span className="shrink-0 text-[12px] text-gray-700 tabular-nums">{relativeTime(site.atMs, now.getTime())}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

/* --------------------------------- to-dos -------------------------------- */

/**
 * Today's to-dos, one list for every home page in this window (a split can
 * show two), kept in this browser's storage (lib/home.ts).
 */
export const useTodos = create<{ todos: HomeTodo[]; write: (todos: HomeTodo[]) => void }>((set) => ({
  todos: loadTodos(new Date()),
  write: (todos) => {
    saveTodos(todos);
    set({ todos });
  },
}));

export function TodayTodos({ now }: { now: Date }) {
  const todos = useTodos((s) => s.todos);
  const write = useTodos((s) => s.write);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const today = startOfDay(now).getTime();

  // A new day clears what was finished on the last one.
  useEffect(() => {
    const current = useTodos.getState().todos;
    const kept = parseTodos(JSON.stringify(current), new Date(today));
    if (kept.length !== current.length) write(kept);
  }, [today, write]);

  // Another tab of this browser changed the list.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "pistachio.home.todos") useTodos.setState({ todos: loadTodos(new Date()) });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const add = () => {
    if (draft.trim() === "") return;
    write(addTodo(useTodos.getState().todos, draft, Date.now(), crypto.randomUUID()));
    setDraft("");
  };

  return (
    <HomeCard
      testId="home-todos"
      title="Today"
      action={
        <button
          type="button"
          aria-label="Add a to-do"
          title="Add a to-do"
          data-testid="home-todo-add"
          onClick={() => setAdding(true)}
          className="grid size-7 cursor-pointer place-items-center rounded-lg text-gray-800 hover:bg-alpha-100 hover:text-gray-1000"
        >
          <Plus className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
        </button>
      }
    >
      <ul className="-mx-2 flex min-h-0 flex-col overflow-y-auto">
        {orderedTodos(todos).map((item) => (
          <li key={item.id} data-testid="home-todo" className="group/todo flex items-center gap-3 rounded-xl px-2 py-[7px] hover:bg-alpha-100">
            <button
              type="button"
              role="checkbox"
              aria-checked={item.done}
              aria-label={item.text}
              onClick={() => write(toggleTodo(useTodos.getState().todos, item.id, Date.now()))}
              className={cn(
                "grid size-[19px] shrink-0 cursor-pointer place-items-center rounded-full border-[1.5px] transition-colors duration-100",
                item.done ? "border-gray-700 bg-gray-700 text-background-100" : "border-gray-500 hover:border-gray-800",
              )}
            >
              {item.done ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : null}
            </button>
            <span className={cn("min-w-0 flex-1 truncate text-[14px]", item.done ? "text-gray-700 line-through" : "text-gray-1000")}>{item.text}</span>
            <button
              type="button"
              aria-label={`Remove “${item.text}”`}
              onClick={() => write(removeTodo(useTodos.getState().todos, item.id))}
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-gray-700 opacity-0 transition-opacity group-hover/todo:opacity-100 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:opacity-100"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {adding ? (
          <li className="flex items-center gap-3 px-2 py-[7px]">
            <span aria-hidden="true" className="size-[19px] shrink-0 rounded-full border-[1.5px] border-dashed border-gray-500" />
            <input
              autoFocus
              type="text"
              aria-label="New to-do"
              data-testid="home-todo-input"
              placeholder="What needs doing today?"
              maxLength={MAX_TODO_TEXT}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft("");
                  setAdding(false);
                }
              }}
              onBlur={() => {
                add();
                setAdding(false);
              }}
              className="h-6 min-w-0 flex-1 bg-transparent text-[14px] text-gray-1000 outline-none placeholder:text-gray-700"
            />
          </li>
        ) : null}
      </ul>
      {todos.length === 0 && !adding ? (
        <CardNote>
          Nothing on today’s list.{" "}
          <button type="button" onClick={() => setAdding(true)} className="cursor-pointer text-gray-1000 underline decoration-alpha-500 underline-offset-2">
            Add a to-do
          </button>
        </CardNote>
      ) : null}
    </HomeCard>
  );
}

/* -------------------------------- schedule ------------------------------- */

/**
 * Today, from both calendars the person has: the reminders' own — what
 * fired and what is still to come, the same items the reminders page draws
 * on today's cell — and the events of a Google Calendar connected in
 * Settings → Integrations, all in the viewer's zone. An event opens in
 * Google Calendar; one with a video call offers it until the event is over.
 */
export function TodaySchedule({ navigation, now }: { navigation: HomeNavigation; now: Date }) {
  const reminders = useAppStore((s) => s.reminders);
  const loaded = useAppStore((s) => s.remindersLoaded);
  const openReminders = useAppStore((s) => s.openReminders);
  const openSettings = useAppStore((s) => s.openSettings);
  const calendar = useCalendarAgenda();
  const promptDismissed = useCalendarAgendaStore((s) => s.promptDismissed);
  const dismissPrompt = useCalendarAgendaStore((s) => s.dismissPrompt);
  const inviting = showsCalendarPrompt(calendar, promptDismissed);
  const agenda = useMemo(() => {
    const timezone = systemTimezone();
    return mergeAgenda(todayAgenda(reminders, now, timezone), eventAgenda(calendar?.events ?? [], now, timezone));
  }, [reminders, calendar, now]);
  const shown = agenda.slice(0, AGENDA_ROWS);
  const connected = calendar?.status === "ok";

  return (
    <HomeCard
      testId="home-schedule"
      icon={<CalendarDays className="size-[18px] shrink-0 text-gray-900" strokeWidth={1.75} aria-hidden="true" />}
      title={now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
    >
      {shown.length === 0 ? (
        <CardNote>
          {!loaded
            ? "Loading today’s schedule…"
            : connected
              ? "Nothing on your calendar today."
              : inviting
                ? "Nothing scheduled today."
                : "Nothing scheduled today. Ask Pistachio to remind you of something and it shows up here."}
        </CardNote>
      ) : (
        <ul className="flex flex-col">
          {shown.map((item) => (
            <li
              key={item.id}
              data-testid="home-agenda-item"
              data-kind={item.kind}
              className={cn("flex items-baseline gap-4 py-[7px] text-[14px]", item.past && "opacity-55")}
            >
              {item.allDay === true ? (
                <span className="w-[74px] shrink-0 text-gray-700">All day</span>
              ) : (
                <time dateTime={item.at} className={cn("w-[74px] shrink-0 tabular-nums", item.live === true ? "font-medium text-gray-1000" : "text-gray-700")}>
                  {item.live === true ? "Now" : timeOf(item.at)}
                </time>
              )}
              {typeof item.webUrl === "string" ? (
                <button
                  type="button"
                  title={item.title}
                  onClick={() => navigation.open(item.webUrl ?? "")}
                  className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-gray-1000 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {item.title}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-gray-1000">{item.title}</span>
              )}
              {typeof item.meetingUrl === "string" && !item.past ? (
                <button
                  type="button"
                  data-testid="home-agenda-join"
                  aria-label={`Join ${item.title}`}
                  onClick={() => navigation.open(item.meetingUrl ?? "")}
                  className="flex h-6 shrink-0 cursor-pointer items-center gap-1 self-center rounded-md bg-alpha-100 px-2 text-[12px] font-medium text-gray-1000 transition-colors hover:bg-alpha-200"
                >
                  <Video className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Join
                </button>
              ) : null}
            </li>
          ))}
          {agenda.length > AGENDA_ROWS ? (
            <li className="pt-0.5 text-[12px] text-gray-700">{`+${String(agenda.length - AGENDA_ROWS)} more today`}</li>
          ) : null}
        </ul>
      )}
      {inviting ? (
        <div data-testid="home-calendar-connect" className="relative mb-2.5 rounded-xl border border-dashed border-alpha-500 px-3 py-2 pr-8">
          <p className="text-[13px] leading-snug text-gray-900">See today’s Google Calendar events here.</p>
          <button
            type="button"
            data-testid="home-calendar-connect-action"
            onClick={() => openSettings("integrations")}
            className="mt-0.5 cursor-pointer text-[13px] font-medium text-gray-1000 hover:underline"
          >
            Connect Google Calendar
          </button>
          <button
            type="button"
            data-testid="home-calendar-connect-dismiss"
            aria-label="Don’t show this again"
            title="Don’t show this again"
            onClick={dismissPrompt}
            className="absolute top-1.5 right-1.5 flex size-6 cursor-pointer items-center justify-center rounded-md text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-1000"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {calendar?.status === "reconnect_required" ? (
        <CardNote>
          Google Calendar needs reconnecting before its events show here.{" "}
          <button type="button" data-testid="home-calendar-reconnect" onClick={() => openSettings("integrations")} className="cursor-pointer font-medium text-gray-1000 hover:underline">
            Open Integrations
          </button>
        </CardNote>
      ) : null}
      <button
        type="button"
        data-testid="home-open-calendar"
        onClick={() => openReminders()}
        className="mt-auto flex h-10 w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-xl bg-alpha-100 px-3 text-[13.5px] font-medium text-gray-1000 transition-colors hover:bg-alpha-200"
      >
        <CalendarDays className="size-4 text-gray-900" strokeWidth={1.75} aria-hidden="true" />
        Open calendar
        <ArrowRight className="ml-auto size-4 text-gray-800" aria-hidden="true" />
      </button>
    </HomeCard>
  );
}
