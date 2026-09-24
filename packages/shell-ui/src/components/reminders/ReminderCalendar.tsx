/**
 * The month grid: every day shows what fired and what is coming, pills
 * coloured by what happened. Drawn in the viewer's zone — the same zone the
 * page keys its items by — so a reminder at 11 PM lands on the day the
 * person will look for it.
 *
 * An ARIA grid in full: rows of gridcells, one tab stop, and the keyboard
 * pattern of day-grid.ts. Each cell's button keeps its native semantics;
 * the gridcell is the box around it.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarItem } from "@pistachio/shell-contracts/reminders";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { calendarItemTitle, calendarPillClass, monthCells, monthOf, useDayGrid, type CalendarMonth } from "./day-grid";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PILLS = 3;

export function ReminderCalendar({
  month,
  selected,
  today,
  items,
  onSelect,
  onMonth,
  trailing,
}: {
  month: CalendarMonth;
  /** "YYYY-MM-DD". */
  selected: string | null;
  today: string;
  items: ReadonlyMap<string, CalendarItem[]>;
  onSelect(day: string): void;
  onMonth(next: CalendarMonth): void;
  /** Controls at the end of the navigation row: the view switch. */
  trailing?: React.ReactNode;
}) {
  const weeks = monthCells(month);
  const grid = useDayGrid(
    weeks.flat(),
    [selected, today, weeks.flat().find((cell) => cell.inMonth)?.key ?? null],
    (date) => onMonth(monthOf(date)),
  );
  const label = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(month.year, month.month - 1, 1));
  const step = (delta: number): CalendarMonth => monthOf(new Date(month.year, month.month - 1 + delta, 1));

  return (
    <div className="flex flex-col gap-2" data-testid="reminder-calendar">
      <div className="flex items-center gap-1">
        <Button variant="tertiary" size="xs" svgOnly aria-label="Previous month" onClick={() => onMonth(step(-1))}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button variant="tertiary" size="xs" svgOnly aria-label="Next month" onClick={() => onMonth(step(1))}>
          <ChevronRight aria-hidden="true" />
        </Button>
        <h2 className="ml-1 text-heading-14 text-gray-1000" aria-live="polite">
          {label}
        </h2>
        <Button
          variant="tertiary"
          size="xs"
          className="ml-auto"
          onClick={() => {
            onMonth({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) });
            onSelect(today);
            grid.focus(today);
          }}
        >
          Today
        </Button>
        {trailing}
      </div>
      <div role="grid" aria-label={label} className="flex flex-col gap-px overflow-hidden rounded-md bg-alpha-400 shadow-border">
        <div role="row" className="grid grid-cols-7 gap-px">
          {WEEKDAYS.map((weekday) => (
            <div key={weekday} role="columnheader" className="bg-background-200 py-1.5 text-center text-[10.5px] font-medium tracking-wide text-gray-700 uppercase">
              {weekday}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]!.key} role="row" className="grid grid-cols-7 gap-px">
            {week.map((cell) => {
              const list = items.get(cell.key) ?? [];
              const shown = list.slice(0, MAX_PILLS);
              const isSelected = cell.key === selected;
              const isToday = cell.key === today;
              const count = list.length === 0 ? "" : `, ${String(list.length)} ${list.length === 1 ? "item" : "items"}`;
              return (
                <div key={cell.key} role="gridcell" aria-selected={isSelected} className="min-h-[72px]">
                  <button
                    ref={grid.register(cell.key)}
                    type="button"
                    tabIndex={cell.key === grid.activeKey ? 0 : -1}
                    aria-label={`${cell.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${count}`}
                    aria-current={isToday ? "date" : undefined}
                    data-testid={`calendar-day-${cell.key}`}
                    onClick={() => {
                      grid.focus(cell.key);
                      onSelect(cell.key);
                    }}
                    onKeyDown={(event) => grid.onKeyDown(event, cell)}
                    className={cn(
                      "flex h-full w-full cursor-pointer flex-col items-stretch gap-1 p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      cell.inMonth ? "bg-background-100 hover:bg-gray-100" : "bg-background-200 text-gray-600 hover:bg-gray-100",
                      isSelected && "bg-gray-100 ring-1 ring-inset ring-gray-1000",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-5 place-items-center self-start rounded-full text-[11px] tabular-nums",
                        isToday ? "bg-gray-1000 font-semibold text-background-100" : cell.inMonth ? "text-gray-1000" : "text-gray-600",
                      )}
                    >
                      {cell.date.getDate()}
                    </span>
                    {shown.map((item) => (
                      <span
                        key={item.kind === "upcoming" ? `up:${item.reminder.id}:${item.at}` : `oc:${item.occurrence.id}`}
                        className={cn("block truncate rounded-xs px-1 text-[10px] leading-4", calendarPillClass(item))}
                        title={calendarItemTitle(item)}
                      >
                        {calendarItemTitle(item)}
                      </span>
                    ))}
                    {list.length > MAX_PILLS ? (
                      <span className="px-1 text-[10px] leading-4 text-gray-700">+{list.length - MAX_PILLS} more</span>
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
