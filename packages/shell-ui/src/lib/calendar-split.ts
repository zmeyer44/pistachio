/**
 * How much of the reminders page the calendar takes, per machine: the
 * week strip's height above the detail, and the month rail's width beside
 * it. Clamped on every store, like the console width (lib/panel.ts), so
 * the divider never needs a min/max of its own.
 */

export interface SplitSpec {
  key: string;
  default: number;
  min: number;
  max: number;
}

/** The week strip: tall enough for a header and a few items, short of the whole page. */
export const WEEK_STRIP: SplitSpec = { key: "pistachio:reminders.weekHeight", default: 260, min: 150, max: 600 };
/** The month rail: seven columns of pills need about 300px to stay legible. */
export const MONTH_RAIL: SplitSpec = { key: "pistachio:reminders.monthWidth", default: 400, min: 300, max: 680 };

export function clampSplit(spec: SplitSpec, px: number): number {
  if (!Number.isFinite(px)) return spec.default;
  return Math.min(Math.max(Math.round(px), spec.min), spec.max);
}

export function getStoredSplit(spec: SplitSpec): number {
  try {
    const raw = localStorage.getItem(spec.key);
    return raw === null ? spec.default : clampSplit(spec, Number.parseInt(raw, 10));
  } catch {
    return spec.default;
  }
}

export function storeSplit(spec: SplitSpec, px: number): number {
  const clamped = clampSplit(spec, px);
  try {
    localStorage.setItem(spec.key, String(clamped));
  } catch {
    // Best effort; the size still holds for this session.
  }
  return clamped;
}
