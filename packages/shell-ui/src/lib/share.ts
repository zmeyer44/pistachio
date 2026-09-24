/**
 * Structural sharing for values that arrive over IPC.
 *
 * Everything main publishes is a fresh structured clone, so a tab whose
 * title did not change, a message written an hour ago, and a shelf nobody
 * touched all come back as new objects — and every `React.memo`, `useMemo`,
 * and Zustand selector keyed on identity treats them as changed.
 *
 * `share(previous, next)` returns `next` with every subtree that is
 * deep-equal to the matching subtree of `previous` replaced by the
 * PREVIOUS reference. Unchanged tabs keep their object, unchanged arrays
 * keep theirs, and a snapshot in which nothing changed IS the previous
 * snapshot. The cost is one deep comparison per publish, which is far
 * cheaper than one re-render of the chrome.
 */
export function share<T>(previous: unknown, next: T): T {
  if (previous === next) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let same = previous.length === next.length;
    const out = next.map((item: unknown, index) => {
      const shared = share(previous[index], item);
      if (shared !== previous[index]) same = false;
      return shared;
    });
    return (same ? previous : out) as T;
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const nextKeys = Object.keys(next);
    let same = nextKeys.length === Object.keys(previous).length;
    const out: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const shared = share(previous[key], next[key]);
      if (!(key in previous) || shared !== previous[key]) same = false;
      out[key] = shared;
    }
    return (same ? previous : out) as T;
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
