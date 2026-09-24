/** Shared, deterministic pieces of the Control–Tab MRU switcher. */

export const TAB_SWITCHER_LIMIT = 5;
const TAB_HISTORY_LIMIT = 100;

/** Move one visited tab to the front without letting stale history grow forever. */
export function recordTabVisit(history: readonly string[], tabId: string): string[] {
  return [tabId, ...history.filter((candidate) => candidate !== tabId)].slice(0, TAB_HISTORY_LIMIT);
}

/** Turn a signed number of MRU steps into a list index, wrapping both ways. */
export function tabSwitcherIndex(offset: number, count: number): number {
  if (count < 1) return 0;
  return ((offset % count) + count) % count;
}

