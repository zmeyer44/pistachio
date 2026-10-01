/**
 * Where a sheet's selection goes when it moves `step` columns from `from`:
 * past hidden columns in the direction it moves, and, with no visible
 * column that way, to the nearest one back (never onto a hidden one).
 */
export function nextVisibleColumn(from: number, step: number, hidden: ReadonlySet<number> | undefined, cols: number): number {
  const last = Math.max(0, cols - 1);
  const target = Math.max(0, Math.min(last, from + step));
  if (hidden === undefined || !hidden.has(target)) return target;
  const direction = step < 0 ? -1 : 1;
  for (let col = target; col >= 0 && col <= last; col += direction) if (!hidden.has(col)) return col;
  for (let col = target; col >= 0 && col <= last; col -= direction) if (!hidden.has(col)) return col;
  return from;
}
