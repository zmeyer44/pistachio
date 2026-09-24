/**
 * What the two calendars share: the day arithmetic (in the viewer's zone,
 * which is the zone the page keys its items by) and the ARIA-grid keyboard
 * pattern — one tab stop that roves with the arrow keys, Home/End across
 * the week, PageUp/PageDown across the month, and a page turn when the
 * keyboard walks off the visible range.
 */

import { useEffect, useRef, useState } from "react";
import type { CalendarItem } from "@pistachio/shell-contracts/reminders";

export interface DayCell {
  /** "YYYY-MM-DD". */
  key: string;
  date: Date;
}

export interface CalendarMonth {
  year: number;
  /** 1–12. */
  month: number;
}

export type CalendarView = "week" | "month";

export function keyOf(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Local midnight of a "YYYY-MM-DD" key; today when the key is not one. */
export function dateOf(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(year + month + day)) return new Date();
  return new Date(year, month - 1, day);
}

export function monthOf(date: Date): CalendarMonth {
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The same day of the month `months` on, clamped to that month's length. */
export function addMonths(date: Date, months: number): Date {
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), last));
}

/** The Sunday that starts the week holding `date`. */
export function startOfWeek(date: Date): Date {
  return addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate()), -date.getDay());
}

/** The seven days of the week starting at `start`. */
export function weekCells(start: Date): DayCell[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    return { key: keyOf(date), date };
  });
}

/** The weeks a month grid shows, leading and trailing days included. */
export function monthCells(month: CalendarMonth): Array<Array<DayCell & { inMonth: boolean }>> {
  const first = new Date(month.year, month.month - 1, 1);
  const start = addDays(first, -first.getDay());
  const days = new Date(month.year, month.month, 0).getDate();
  const total = Math.ceil((first.getDay() + days) / 7) * 7;
  const weeks: Array<Array<DayCell & { inMonth: boolean }>> = [];
  for (let index = 0; index < total; index += 1) {
    const date = addDays(start, index);
    if (index % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]!.push({ key: keyOf(date), date, inMonth: date.getMonth() === month.month - 1 });
  }
  return weeks;
}

/** "Aug 24 – 30, 2026", or "Aug 30 – Sep 5, 2026" across a month edge. */
export function weekLabel(start: Date): string {
  const end = addDays(start, 6);
  const month = (date: Date): string => new Intl.DateTimeFormat(undefined, { month: "short" }).format(date);
  const range =
    start.getMonth() === end.getMonth()
      ? `${month(start)} ${String(start.getDate())} – ${String(end.getDate())}`
      : `${month(start)} ${String(start.getDate())} – ${month(end)} ${String(end.getDate())}`;
  return `${range}, ${String(end.getFullYear())}`;
}

/** The items a range of the calendar shows: [from, to], with a day's slack either side. */
export function calendarWindow(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  if (view === "week") {
    const start = startOfWeek(anchor);
    return { from: addDays(start, -1), to: new Date(addDays(start, 7).getTime() + 86_399_000) };
  }
  const month = monthOf(anchor);
  return { from: new Date(month.year, month.month - 1, 1 - 7), to: new Date(month.year, month.month, 7, 23, 59, 59) };
}

export function calendarItemTitle(item: CalendarItem): string {
  return item.kind === "upcoming" ? item.reminder.title : item.occurrence.title;
}

/** How an item reads on a day: outlined while it is still to come, tinted by what happened. */
export function calendarPillClass(item: CalendarItem): string {
  if (item.kind === "upcoming") return "bg-background-100 text-gray-900 shadow-border";
  switch (item.occurrence.status) {
    case "delivered":
    case "completed":
      return "bg-green-100 text-green-900";
    case "failed":
      return "bg-red-100 text-red-900";
    case "missed":
      return "bg-amber-100 text-amber-900";
    case "queued":
    case "running":
      return "bg-blue-100 text-blue-900";
  }
}

/**
 * The roving tab stop for a grid of days. `cells` are the days on screen;
 * `anchors` say where the keyboard starts (the selection, today…); when
 * an arrow walks off the screen, `onOutside` is asked to bring that day
 * on, and focus follows it once it has.
 */
export function useDayGrid(cells: readonly DayCell[], anchors: ReadonlyArray<string | null>, onOutside: (date: Date) => void) {
  const has = (key: string | null): key is string => key !== null && cells.some((cell) => cell.key === key);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const activeKey = [focusKey, ...anchors].find(has) ?? cells[0]?.key ?? "";
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef(false);
  const range = `${cells[0]?.key ?? ""}:${cells.at(-1)?.key ?? ""}`;

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    buttons.current.get(activeKey)?.focus();
  }, [activeKey, range]);

  const moveTo = (date: Date): void => {
    const key = keyOf(date);
    pendingFocus.current = true;
    setFocusKey(key);
    if (!has(key)) onOutside(date);
  };

  return {
    activeKey,
    /** Remember where the keyboard is, without moving it. */
    focus: setFocusKey,
    register: (key: string) => (element: HTMLButtonElement | null) => {
      if (element === null) buttons.current.delete(key);
      else buttons.current.set(key, element);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, cell: DayCell): void => {
      switch (event.key) {
        case "ArrowLeft": moveTo(addDays(cell.date, -1)); break;
        case "ArrowRight": moveTo(addDays(cell.date, 1)); break;
        case "ArrowUp": moveTo(addDays(cell.date, -7)); break;
        case "ArrowDown": moveTo(addDays(cell.date, 7)); break;
        case "Home": moveTo(addDays(cell.date, -cell.date.getDay())); break;
        case "End": moveTo(addDays(cell.date, 6 - cell.date.getDay())); break;
        case "PageUp": moveTo(addMonths(cell.date, -1)); break;
        case "PageDown": moveTo(addMonths(cell.date, 1)); break;
        default: return;
      }
      event.preventDefault();
    },
  };
}
