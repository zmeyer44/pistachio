/**
 * Fired reminders, in the agent chat: every occurrence the person has not
 * dismissed, newest first, as cards above the conversation. A message
 * reminder IS its card; an agent task's card carries the answer its run
 * produced. Dismissing is an acknowledgement main records, so the card
 * stays gone across launches, and the page keeps the history.
 */

import { useMemo, useState } from "react";
import { AlarmClock, AlarmClockOff, ArrowUpRight, Bot, Check, RotateCcw, X } from "lucide-react";
import { unacknowledgedOccurrences, type ReminderOccurrence } from "@pistachio/shell-contracts/reminders";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store";
import { MessageText } from "../MessageText";
import { Button } from "../ui/button";
import { relativeTime, STATUS_LABEL, timeOfDay } from "./parts";

const SHOWN = 3;

const TONE: Record<ReminderOccurrence["status"], { border: string; strip: string; icon: string; eyebrow: string }> = {
  delivered: { border: "border-green-400", strip: "bg-green-100", icon: "bg-green-700 text-white", eyebrow: "text-green-900" },
  completed: { border: "border-green-400", strip: "bg-green-100", icon: "bg-green-700 text-white", eyebrow: "text-green-900" },
  failed: { border: "border-red-400", strip: "bg-red-100", icon: "bg-red-700 text-white", eyebrow: "text-red-900" },
  missed: { border: "border-amber-400", strip: "bg-amber-100", icon: "bg-amber-700 text-black", eyebrow: "text-amber-900" },
  queued: { border: "border-blue-400", strip: "bg-blue-100", icon: "bg-blue-700 text-white", eyebrow: "text-blue-900" },
  running: { border: "border-blue-400", strip: "bg-blue-100", icon: "bg-blue-700 text-white", eyebrow: "text-blue-900" },
};

function eyebrow(occurrence: ReminderOccurrence): string {
  if (occurrence.status === "delivered") return "Reminder";
  if (occurrence.status === "completed") return "Scheduled task done";
  if (occurrence.status === "failed") return "Scheduled task failed";
  if (occurrence.status === "missed") return "Missed reminder";
  return STATUS_LABEL[occurrence.status];
}

function Icon({ occurrence }: { occurrence: ReminderOccurrence }) {
  const className = "size-3.5";
  if (occurrence.status === "missed") return <AlarmClockOff className={className} aria-hidden="true" />;
  if (occurrence.status === "failed") return <X className={className} aria-hidden="true" />;
  if (occurrence.actionKind === "agent") return occurrence.status === "completed" ? <Check className={className} aria-hidden="true" /> : <Bot className={className} aria-hidden="true" />;
  return <AlarmClock className={className} aria-hidden="true" />;
}

export function ReminderInbox() {
  const snapshot = useAppStore((state) => state.reminders);
  const acknowledge = useAppStore((state) => state.acknowledgeReminders);
  const openReminders = useAppStore((state) => state.openReminders);
  const pending = useMemo(() => unacknowledgedOccurrences(snapshot), [snapshot]);
  if (pending.length === 0) return null;
  const shown = pending.slice(0, SHOWN);
  const more = pending.length - shown.length;
  return (
    <section aria-label="Fired reminders" data-testid="reminder-inbox" className="mb-5 grid gap-2">
      {shown.map((occurrence) => (
        <ReminderCard key={occurrence.id} occurrence={occurrence} />
      ))}
      {pending.length > 1 ? (
        <div className="flex items-center justify-between px-1 text-[11px] text-gray-700">
          <button type="button" className="flex cursor-pointer items-center gap-1 hover:text-gray-1000" onClick={() => openReminders()}>
            {more > 0 ? `${String(more)} more · ` : ""}Open reminders
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </button>
          <button type="button" className="cursor-pointer hover:text-gray-1000" onClick={() => void acknowledge("all")}>
            Dismiss all
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ReminderCard({ occurrence }: { occurrence: ReminderOccurrence }) {
  const acknowledge = useAppStore((state) => state.acknowledgeReminders);
  const snooze = useAppStore((state) => state.snoozeReminder);
  const openReminders = useAppStore((state) => state.openReminders);
  const [expanded, setExpanded] = useState(false);
  const tone = TONE[occurrence.status];
  const body = occurrence.output ?? occurrence.error ?? "";
  const long = body.length > 320;
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <section
      data-testid="reminder-card"
      data-status={occurrence.status}
      className={cn("min-w-0 overflow-hidden rounded-lg border bg-background-100 shadow-small", tone.border)}
    >
      <div className={cn("flex items-start gap-2.5 px-3.5 py-3", tone.strip)}>
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-full", tone.icon)}>
          <Icon occurrence={occurrence} />
        </span>
        <div className="min-w-0 flex-1">
          <span className={cn("block text-[11px] font-medium tracking-wide uppercase", tone.eyebrow)}>{eyebrow(occurrence)}</span>
          <strong className="mt-0.5 block text-heading-14 break-words text-gray-1000">{occurrence.title}</strong>
        </div>
        <Button variant="tertiary" size="xs" svgOnly aria-label={`Dismiss ${occurrence.title}`} onClick={() => void acknowledge([occurrence.id])}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="p-3.5">
        {body === "" ? null : (
          <>
            <p className={cn("text-copy-13 wrap-anywhere whitespace-pre-wrap text-gray-1000", !expanded && "line-clamp-6")}>
              <MessageText text={body} />
            </p>
            {long ? (
              <button type="button" className="mt-1 cursor-pointer text-label-12 font-medium text-gray-900 hover:text-gray-1000" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show less" : "Show all"}
              </button>
            ) : null}
          </>
        )}
        <p className="mt-2 text-[11px] text-gray-700">
          Due {timeOfDay(occurrence.scheduledFor, timezone)} · {relativeTime(occurrence.finishedAt ?? occurrence.scheduledFor, now)}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Button variant="secondary" size="xs" onClick={() => void acknowledge([occurrence.id])}>
            Got it
          </Button>
          <Button variant="tertiary" size="xs" prefix={<RotateCcw aria-hidden="true" />} onClick={() => void snooze(occurrence.id, 10)}>
            Again in 10 min
          </Button>
          <Button variant="tertiary" size="xs" className="ml-auto" suffix={<ArrowUpRight aria-hidden="true" />} onClick={() => openReminders(occurrence.id)}>
            Details
          </Button>
        </div>
      </div>
    </section>
  );
}
