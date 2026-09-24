/**
 * The small vocabulary the reminders surfaces share: how a status and an
 * action kind look, and how a time reads relative to now. One place, so
 * the console card and the calendar say "Missed" the same way.
 */

import { Bot, MessageSquare } from "lucide-react";
import type { ReminderActionKind, ReminderOccurrenceStatus } from "@pistachio/shell-contracts/reminders";
import { Badge } from "../ui/badge";

export const STATUS_LABEL: Record<ReminderOccurrenceStatus, string> = {
  queued: "Waiting for the agent",
  running: "Running",
  delivered: "Delivered",
  completed: "Done",
  failed: "Failed",
  missed: "Missed",
};

const STATUS_VARIANT: Record<ReminderOccurrenceStatus, "blue-subtle" | "green-subtle" | "red-subtle" | "amber-subtle"> = {
  queued: "blue-subtle",
  running: "blue-subtle",
  delivered: "green-subtle",
  completed: "green-subtle",
  failed: "red-subtle",
  missed: "amber-subtle",
};

export function StatusBadge({ status }: { status: ReminderOccurrenceStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} size="sm" className={status === "running" ? "animate-pulse" : undefined}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function KindBadge({ kind }: { kind: ReminderActionKind }) {
  return kind === "agent" ? (
    <Badge variant="blue-subtle" size="sm" icon={<Bot aria-hidden="true" />}>
      Agent task
    </Badge>
  ) : (
    <Badge variant="gray-subtle" size="sm" icon={<MessageSquare aria-hidden="true" />}>
      Message
    </Badge>
  );
}

/** "in 20 min", "2 h ago", "just now". */
export function relativeTime(iso: string, now: Date): string {
  const delta = Date.parse(iso) - now.getTime();
  if (Number.isNaN(delta)) return "";
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60_000);
  let span: string;
  if (minutes < 1) return "just now";
  if (minutes < 60) span = `${String(minutes)} min`;
  else if (minutes < 60 * 24) span = `${String(Math.round(minutes / 60))} h`;
  else span = `${String(Math.round(minutes / (60 * 24)))} d`;
  return delta > 0 ? `in ${span}` : `${span} ago`;
}

/** "3:40 PM" in a zone. */
export function timeOfDay(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** "Thursday, August 27" for a "YYYY-MM-DD" day key. */
export function dayHeading(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return dayKey;
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date(year, month - 1, day));
}
