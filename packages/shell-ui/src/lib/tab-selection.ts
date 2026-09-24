export interface TabSelectionModifiers {
  range: boolean;
  additive: boolean;
}

export interface TabSelectionUpdate {
  selected: Set<string>;
  anchor: string;
  /** A plain click activates the tab; modifier clicks only edit the selection. */
  activate: boolean;
}

/**
 * File-explorer selection over tabs in visible sidebar order. Shift replaces
 * the selection with a range, Ctrl/Command toggles one item, and combining
 * them adds a range to the existing selection.
 */
export function updateTabSelection(
  order: readonly string[],
  current: ReadonlySet<string>,
  anchor: string | null,
  target: string,
  modifiers: TabSelectionModifiers,
): TabSelectionUpdate {
  if (modifiers.range) {
    const from = anchor !== null && order.includes(anchor) ? anchor : target;
    const start = order.indexOf(from);
    const end = order.indexOf(target);
    const range = start < 0 || end < 0
      ? [target]
      : order.slice(Math.min(start, end), Math.max(start, end) + 1);
    const selected = modifiers.additive ? new Set(current) : new Set<string>();
    for (const key of range) selected.add(key);
    return { selected, anchor: from, activate: false };
  }

  if (modifiers.additive) {
    const selected = new Set(current);
    if (selected.has(target)) selected.delete(target);
    else selected.add(target);
    return { selected, anchor: target, activate: false };
  }

  return { selected: new Set(), anchor: target, activate: true };
}
