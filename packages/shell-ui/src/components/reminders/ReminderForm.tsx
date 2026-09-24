/**
 * Create or edit a reminder by hand. The same shape the agent's tool
 * fills in, laid out for a person: what to say or do, then when — once at
 * a moment, every day, on weekdays, monthly, or every so many minutes — in
 * whichever zone they mean. Main validates and the failure reads beside
 * the fields, not in the shell's banner.
 */

import { useState } from "react";
import { Check } from "lucide-react";
import {
  formatClockTime,
  isValidTimezone,
  MAX_REMINDER_MESSAGE,
  MAX_REMINDER_PROMPT,
  MAX_REMINDER_TITLE,
  systemTimezone,
  wallClock,
  zonedTimeToUtc,
  type Reminder,
  type ReminderAction,
  type ReminderActionKind,
  type ReminderInput,
  type ReminderPatch,
  type ReminderSchedule,
  type ReminderScheduleKind,
} from "@pistachio/shell-contracts/reminders";
import { cn } from "../../lib/cn";
import { copyFor, type CopySurface } from "../../lib/surface-copy";
import { useAppStore } from "../../store";
import { useSurface } from "../../surface";
import { Button } from "../ui/button";
import { Fieldset, FieldsetContent, FieldsetFooter, FieldsetFooterActions, FieldsetFooterStatus, FieldsetSubtitle, FieldsetTitle } from "../ui/fieldset";
import { Input } from "../ui/input";
import { Note } from "../ui/note";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";

const KIND_ITEMS: ReadonlyArray<{ value: ReminderActionKind; label: string }> = [
  { value: "message", label: "Show me a message" },
  { value: "agent", label: "Run an agent task" },
];

const REPEAT_ITEMS: ReadonlyArray<{ value: ReminderScheduleKind; label: string }> = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "interval", label: "Every few minutes" },
];

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Every zone the runtime knows, the host's own first. Only that first row's
 * words differ by surface (`lib/surface-copy.ts`): in a browser tab the zone
 * being followed is the browser's, not a Mac's.
 */
function timezoneItems(surface: CopySurface): ReadonlyArray<{ value: string; label: string }> {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const system = systemTimezone();
  return [
    { value: system, label: copyFor(surface).reminders.systemZone(system.replaceAll("_", " ")) },
    ...zones.filter((zone) => zone !== system).map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") })),
  ];
}
/** Both lists, built once at module load: the zone database is long. */
const TIMEZONES: Record<CopySurface, ReadonlyArray<{ value: string; label: string }>> = {
  native: timezoneItems("native"),
  stream: timezoneItems("stream"),
};
const DAY_ITEMS = Array.from({ length: 31 }, (_, index) => ({ value: index + 1, label: String(index + 1) }));

/** "YYYY-MM-DDTHH:MM" as a datetime-local field wants, for an instant in a zone. */
function localInput(iso: string, timezone: string): string {
  const w = wallClock(new Date(iso), timezone);
  return `${String(w.year)}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}T${formatClockTime(w.hour, w.minute)}`;
}

/** The instant a datetime-local value names in a zone, or null. */
function instantOf(value: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) return null;
  return zonedTimeToUtc({ year, month, day, hour, minute }, timezone).toISOString();
}

interface Draft {
  title: string;
  kind: ReminderActionKind;
  message: string;
  prompt: string;
  repeat: ReminderScheduleKind;
  /** once: datetime-local in `timezone`. */
  when: string;
  /** daily / weekly / monthly: "HH:MM". */
  time: string;
  days: number[];
  dayOfMonth: number;
  everyMinutes: number;
  timezone: string;
  /** Recurring: datetime-local, or "" for no end. */
  until: string;
}

function draftFor(reminder: Reminder | null, now: Date): Draft {
  const timezone = reminder?.timezone ?? systemTimezone();
  const soon = new Date(Math.ceil((now.getTime() + 30 * 60_000) / (5 * 60_000)) * 5 * 60_000);
  const today = wallClock(now, timezone);
  const base: Draft = {
    title: reminder?.title ?? "",
    kind: reminder?.action.kind ?? "message",
    message: reminder?.action.kind === "message" ? reminder.action.text : "",
    prompt: reminder?.action.kind === "agent" ? reminder.action.prompt : "",
    repeat: reminder?.schedule.kind ?? "once",
    when: localInput(soon.toISOString(), timezone),
    time: "09:00",
    days: [today.weekday],
    dayOfMonth: today.day,
    everyMinutes: 60,
    timezone,
    until: reminder?.until === null || reminder?.until === undefined ? "" : localInput(reminder.until, timezone),
  };
  const schedule = reminder?.schedule;
  if (schedule === undefined) return base;
  switch (schedule.kind) {
    case "once":
      return { ...base, when: localInput(schedule.at, timezone) };
    case "daily":
      return { ...base, time: schedule.time };
    case "weekly":
      return { ...base, time: schedule.time, days: schedule.days };
    case "monthly":
      return { ...base, time: schedule.time, dayOfMonth: schedule.day };
    case "interval":
      return { ...base, everyMinutes: schedule.everyMinutes };
  }
}

function scheduleOf(draft: Draft, now: Date): ReminderSchedule | string {
  switch (draft.repeat) {
    case "once": {
      const at = instantOf(draft.when, draft.timezone);
      if (at === null) return "Pick a date and time.";
      if (Date.parse(at) <= now.getTime()) return "That time has already passed.";
      return { kind: "once", at };
    }
    case "daily":
      return { kind: "daily", time: draft.time };
    case "weekly":
      if (draft.days.length === 0) return "Pick at least one day of the week.";
      return { kind: "weekly", days: [...draft.days].sort((a, b) => a - b), time: draft.time };
    case "monthly":
      return { kind: "monthly", day: draft.dayOfMonth, time: draft.time };
    case "interval":
      if (!Number.isInteger(draft.everyMinutes) || draft.everyMinutes < 1) return "Every how many minutes?";
      return { kind: "interval", everyMinutes: draft.everyMinutes, startAt: now.toISOString() };
  }
}

function actionOf(draft: Draft): ReminderAction | string {
  if (draft.kind === "message") {
    const text = draft.message.trim();
    return text === "" ? "What should the reminder say?" : { kind: "message", text };
  }
  const prompt = draft.prompt.trim();
  return prompt === "" ? "What should the agent do?" : { kind: "agent", prompt };
}

export function ReminderForm({ reminder, onDone }: { reminder: Reminder | null; onDone(): void }) {
  const addReminder = useAppStore((state) => state.addReminder);
  const updateReminder = useAppStore((state) => state.updateReminder);
  const [draft, setDraft] = useState<Draft>(() => draftFor(reminder, new Date()));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));
  const recurring = draft.repeat !== "once";
  const surface = useSurface().kind;
  const copy = copyFor(surface).reminders;

  const submit = async () => {
    const now = new Date();
    const action = actionOf(draft);
    if (typeof action === "string") {
      setError(action);
      return;
    }
    const schedule = scheduleOf(draft, now);
    if (typeof schedule === "string") {
      setError(schedule);
      return;
    }
    if (!isValidTimezone(draft.timezone)) {
      setError(copy.unknownZone);
      return;
    }
    const until = recurring && draft.until !== "" ? instantOf(draft.until, draft.timezone) : null;
    if (recurring && draft.until !== "" && until === null) {
      setError("The end date is not a date.");
      return;
    }
    setSaving(true);
    setError(null);
    const title = draft.title.trim();
    const failure =
      reminder === null
        ? await addReminder({ title, schedule, action, timezone: draft.timezone, until } satisfies ReminderInput)
        : await updateReminder(reminder.id, { title: title === "" ? undefined : title, schedule, action, timezone: draft.timezone, until } satisfies ReminderPatch);
    setSaving(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    onDone();
  };

  return (
    <Fieldset data-testid="reminder-form">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FieldsetContent>
          <FieldsetTitle>{reminder === null ? "New reminder" : "Edit reminder"}</FieldsetTitle>
          <FieldsetSubtitle>
            A message shows up in the agent chat when it is time. An agent task starts a conversation of its own and does the work, with
            every tool the agent has.
          </FieldsetSubtitle>
          <div className="mt-4 flex flex-col gap-4">
            <Input
              label="Title"
              placeholder="Take the cookies out"
              maxLength={MAX_REMINDER_TITLE}
              value={draft.title}
              onChange={(event) => patch({ title: event.target.value })}
              description="Optional. The first line of the message or task is used otherwise."
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-label-13 text-gray-1000">What happens</span>
              <Select aria-label="What happens" value={draft.kind} items={KIND_ITEMS} onValueChange={(kind) => patch({ kind })} className="w-56" />
            </div>
            {draft.kind === "message" ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="reminder-message" className="text-label-13 text-gray-1000">
                  Message
                </label>
                <Textarea
                  id="reminder-message"
                  placeholder="Time to take the cookies out of the oven."
                  maxLength={MAX_REMINDER_MESSAGE}
                  value={draft.message}
                  onChange={(event) => patch({ message: event.target.value })}
                  className="min-h-20 text-copy-13"
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="reminder-prompt" className="text-label-13 text-gray-1000">
                  Instructions for the agent
                </label>
                <Textarea
                  id="reminder-prompt"
                  placeholder="Open my calendar, read the coming week, and send me a summary of what is on it and anything that needs preparing."
                  maxLength={MAX_REMINDER_PROMPT}
                  value={draft.prompt}
                  onChange={(event) => patch({ prompt: event.target.value })}
                  className="min-h-28 text-copy-13"
                />
                <span className="text-label-12 text-gray-900">
                  The task runs in your browser session with your open tabs. It will not remember this form — write everything it needs.
                </span>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-label-13 text-gray-1000">Repeat</span>
                <Select aria-label="Repeat" value={draft.repeat} items={REPEAT_ITEMS} onValueChange={(repeat) => patch({ repeat })} className="w-44" />
              </div>
              {draft.repeat === "once" ? (
                <Input
                  label="When"
                  type="datetime-local"
                  value={draft.when}
                  onChange={(event) => patch({ when: event.target.value })}
                  containerClassName="w-56"
                />
              ) : null}
              {draft.repeat === "daily" || draft.repeat === "weekly" || draft.repeat === "monthly" ? (
                <Input label="At" type="time" value={draft.time} onChange={(event) => patch({ time: event.target.value })} containerClassName="w-32" />
              ) : null}
              {draft.repeat === "monthly" ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-label-13 text-gray-1000">Day of month</span>
                  <Select aria-label="Day of month" value={draft.dayOfMonth} items={DAY_ITEMS} onValueChange={(dayOfMonth) => patch({ dayOfMonth })} className="w-24" />
                </div>
              ) : null}
              {draft.repeat === "interval" ? (
                <Input
                  label="Every (minutes)"
                  type="number"
                  min={1}
                  value={String(draft.everyMinutes)}
                  onChange={(event) => patch({ everyMinutes: Number(event.target.value) })}
                  containerClassName="w-36"
                />
              ) : null}
            </div>
            {draft.repeat === "weekly" ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-label-13 text-gray-1000">On</span>
                <div role="group" aria-label="Days of the week" className="flex items-center gap-1">
                  {WEEKDAYS.map((letter, day) => {
                    const on = draft.days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        aria-label={WEEKDAY_NAMES[day]}
                        onClick={() => patch({ days: on ? draft.days.filter((d) => d !== day) : [...draft.days, day] })}
                        className={cn(
                          "grid size-8 cursor-pointer place-items-center rounded-full text-label-12 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                          on ? "bg-gray-1000 text-background-100" : "bg-background-100 text-gray-900 shadow-border hover:bg-gray-100",
                        )}
                      >
                        {letter}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-label-13 text-gray-1000">Time zone</span>
                <Select aria-label="Time zone" value={draft.timezone} items={TIMEZONES[surface]} onValueChange={(timezone) => patch({ timezone })} className="w-64" />
              </div>
              {recurring ? (
                <Input
                  label="Ends"
                  type="datetime-local"
                  value={draft.until}
                  onChange={(event) => patch({ until: event.target.value })}
                  description="Optional."
                  containerClassName="w-56"
                />
              ) : null}
            </div>
            {error === null ? null : (
              <Note type="error" size="sm" role="alert">
                {error}
              </Note>
            )}
          </div>
        </FieldsetContent>
        <FieldsetFooter highlight>
          <FieldsetFooterStatus>Runs while Pistachio is open. A reminder due while it was closed is shown as missed.</FieldsetFooterStatus>
          <FieldsetFooterActions>
            <Button variant="tertiary" size="sm" onClick={onDone} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving} prefix={<Check aria-hidden="true" />} data-testid="reminder-save">
              {reminder === null ? "Schedule" : "Save"}
            </Button>
          </FieldsetFooterActions>
        </FieldsetFooter>
      </form>
    </Fieldset>
  );
}
