import { describe, expect, it } from "vitest";
import {
  addMonths,
  calendarWindow,
  dateOf,
  keyOf,
  monthCells,
  startOfWeek,
  weekCells,
  weekLabel,
} from "../src/components/reminders/day-grid";

describe("day grid arithmetic", () => {
  it("keys and reads local days", () => {
    expect(keyOf(new Date(2026, 7, 27))).toBe("2026-08-27");
    expect(keyOf(dateOf("2026-08-27"))).toBe("2026-08-27");
    expect(dateOf("2026-08-27").getHours()).toBe(0);
  });

  it("starts a week on Sunday and lays out seven days", () => {
    // 2026-08-27 is a Thursday.
    expect(keyOf(startOfWeek(new Date(2026, 7, 27)))).toBe("2026-08-23");
    expect(keyOf(startOfWeek(new Date(2026, 7, 23)))).toBe("2026-08-23");
    expect(weekCells(new Date(2026, 7, 23)).map((cell) => cell.key)).toEqual([
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-29",
    ]);
  });

  it("labels a week within a month and across one", () => {
    expect(weekLabel(new Date(2026, 7, 23))).toBe("Aug 23 – 29, 2026");
    expect(weekLabel(new Date(2026, 7, 30))).toBe("Aug 30 – Sep 5, 2026");
    expect(weekLabel(new Date(2026, 11, 27))).toBe("Dec 27 – Jan 2, 2027");
  });

  it("clamps a month step to the shorter month", () => {
    expect(keyOf(addMonths(new Date(2026, 0, 31), 1))).toBe("2026-02-28");
    expect(keyOf(addMonths(new Date(2026, 2, 31), -1))).toBe("2026-02-28");
    expect(keyOf(addMonths(new Date(2026, 7, 27), 1))).toBe("2026-09-27");
  });

  it("fills whole weeks around a month, leading and trailing days marked", () => {
    const weeks = monthCells({ year: 2026, month: 8 });
    expect(weeks).toHaveLength(6);
    expect(weeks[0]!.map((cell) => cell.key)).toEqual(["2026-07-26", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"]);
    expect(weeks[0]!.map((cell) => cell.inMonth)).toEqual([false, false, false, false, false, false, true]);
    expect(weeks.at(-1)!.at(-1)!.key).toBe("2026-09-05");
    // February 2026 starts on a Sunday and is exactly four weeks.
    expect(monthCells({ year: 2026, month: 2 })).toHaveLength(4);
  });

  it("windows the items each view needs, with a day's slack", () => {
    const week = calendarWindow("week", new Date(2026, 7, 27));
    expect(keyOf(week.from)).toBe("2026-08-22");
    expect(keyOf(week.to)).toBe("2026-08-30");
    const month = calendarWindow("month", new Date(2026, 7, 27));
    expect(keyOf(month.from)).toBe("2026-07-25");
    expect(keyOf(month.to)).toBe("2026-09-07");
  });
});
