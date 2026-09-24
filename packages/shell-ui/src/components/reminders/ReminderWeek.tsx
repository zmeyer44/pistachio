/**
 * The week strip: seven columns, every item timed, across the width of the
 * page. The default view — a week is what a person plans in, and the room
 * lets each fire show its time and title rather than a pill. Same ARIA
 * grid pattern as the month (day-grid.ts): one row of gridcells, one tab
 * stop, arrows walk days, Up/Down turn the week.
 *
 * The strip fills whatever height the page gives it (the divider under it
 * sets that) and scrolls inside when a day has more than fits, so every
 * item is reachable however compact the strip is.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarItem } from "@pistachio/shell-contracts/reminders";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { addDays, calendarItemTitle, calendarPillClass, startOfWeek, useDayGrid, weekCells, weekLabel } from "./day-grid";
import { timeOfDay } from "./parts";

export function ReminderWeek({
  weekStart,
  selected,
  today,
  items,
  timezone,
  onSelect,
  onWeek,
  trailing,
}: {
  /** The Sunday the strip starts on. */
  weekStart: Date;
  /** "YYYY-MM-DD". */
  selected: string | null;
  today: string;
  items: ReadonlyMap<string, CalendarItem[]>;
  timezone: string;
  onSelect(day: string): void;
  onWeek(start: Date): void;
  /** Controls at the end of the navigation row: the view switch. */
  trailing?: React.ReactNode;
}) {
  const cells = weekCells(weekStart);
  const grid = useDayGrid(cells, [selected, today], (date) => onWeek(startOfWeek(date)));
  const label = weekLabel(weekStart);
  const todayDate = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="reminder-week">
      <div className="flex items-center gap-1">
        <Button variant="tertiary" size="xs" svgOnly aria-label="Previous week" onClick={() => onWeek(addDays(weekStart, -7))}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button variant="tertiary" size="xs" svgOnly aria-label="Next week" onClick={() => onWeek(addDays(weekStart, 7))}>
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
            onWeek(startOfWeek(todayDate));
            onSelect(today);
            grid.focus(today);
          }}
        >
          Today
        </Button>
        {trailing}
      </div>
      <div role="grid" aria-label={label} className="scroll-thin min-h-0 flex-1 overflow-y-auto rounded-md bg-alpha-400 shadow-border">
        <div role="row" className="grid min-h-full grid-cols-7 gap-px">
          {cells.map((cell) => {
            const list = items.get(cell.key) ?? [];
            const isSelected = cell.key === selected;
            const isToday = cell.key === today;
            const past = cell.date.getTime() < todayDate.getTime();
            const count = list.length === 0 ? "" : `, ${String(list.length)} ${list.length === 1 ? "item" : "items"}`;
            return (
              <div key={cell.key} role="gridcell" aria-selected={isSelected} className="min-h-24 min-w-0">
                <button
                  ref={grid.register(cell.key)}
                  type="button"
                  tabIndex={cell.key === grid.activeKey ? 0 : -1}
                  aria-label={`${cell.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${count}`}
                  aria-current={isToday ? "date" : undefined}
                  data-testid={`week-day-${cell.key}`}
                  onClick={() => {
                    grid.focus(cell.key);
                    onSelect(cell.key);
                  }}
                  onKeyDown={(event) => grid.onKeyDown(event, cell)}
                  className={cn(
                    "flex h-full w-full min-w-0 cursor-pointer flex-col items-stretch gap-1 p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    past ? "bg-background-200 hover:bg-gray-100" : "bg-background-100 hover:bg-gray-100",
                    isSelected && "bg-gray-100 ring-1 ring-inset ring-gray-1000",
                  )}
                >
                  <span className="mb-1 flex items-center gap-1.5 px-0.5">
                    <span className="text-[10.5px] font-medium tracking-wide text-gray-700 uppercase">
                      {cell.date.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <span
                      className={cn(
                        "grid size-5 place-items-center rounded-full text-[11px] tabular-nums",
                        isToday ? "bg-gray-1000 font-semibold text-background-100" : "text-gray-1000",
                      )}
                    >
                      {cell.date.getDate()}
                    </span>
                  </span>
                  {list.map((item) => (
                    <span
                      key={item.kind === "upcoming" ? `up:${item.reminder.id}:${item.at}` : `oc:${item.occurrence.id}`}
                      className={cn("grid min-w-0 grid-cols-[auto_1fr] items-baseline gap-1 rounded-xs px-1 py-0.5 text-[10.5px] leading-4", calendarPillClass(item))}
                      title={`${timeOfDay(item.at, timezone)} · ${calendarItemTitle(item)}`}
                    >
                      <span className="tabular-nums opacity-80">{timeOfDay(item.at, timezone)}</span>
                      <span className="truncate">{calendarItemTitle(item)}</span>
                    </span>
                  ))}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
