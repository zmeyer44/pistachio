/**
 * From probabilities to the list the person steps through
 * (docs/smart-find.md §6). Pure: no model, no page, no clock.
 */
import { SMART_FIND_LIMITS, type SmartFindMatch, type SmartFindPassage } from "./contract.js";

export interface SmartFindSelection {
  matches: SmartFindMatch[];
  /** No confident match: these are only the closest passages. */
  weak: boolean;
}

/**
 * Matches, best first. Adjacent parts of one split block are one match.
 * `final` is whether every batch has reported: only then is "nothing
 * matched" known, and only then are the closest passages offered instead.
 */
export function selectMatches(
  passages: readonly SmartFindPassage[],
  scores: ReadonlyMap<string, number>,
  final: boolean,
): SmartFindSelection {
  const gather = (floor: number): (SmartFindMatch & { order: number })[] => {
    const out: (SmartFindMatch & { order: number })[] = [];
    let open: (SmartFindMatch & { order: number; block: string }) | null = null;
    passages.forEach((passage, order) => {
      const probability = scores.get(passage.id);
      if (probability === undefined || probability < floor) {
        open = null;
        return;
      }
      if (open !== null && open.block === passage.block) {
        open.ids.push(passage.id);
        open.probability = Math.max(open.probability, probability);
        return;
      }
      open = { ids: [passage.id], probability, order, block: passage.block };
      out.push(open);
    });
    // Best first; the page's own order settles a tie.
    return out.sort((a, b) => b.probability - a.probability || a.order - b.order);
  };
  const strip = (list: (SmartFindMatch & { order: number })[]): SmartFindMatch[] =>
    list.map(({ ids, probability }) => ({ ids, probability }));
  const matched = gather(SMART_FIND_LIMITS.match);
  if (matched.length > 0) return { matches: strip(matched.slice(0, SMART_FIND_LIMITS.matches)), weak: false };
  if (!final) return { matches: [], weak: false };
  const closest = gather(SMART_FIND_LIMITS.closest).slice(0, SMART_FIND_LIMITS.closestCount);
  return { matches: strip(closest), weak: closest.length > 0 };
}

const keyOf = (match: SmartFindMatch): string => match.ids[0]!;

/**
 * Fold a fresh selection into the list on screen without moving anything
 * under the person's hands. Until they step (`pinned`), the list is simply
 * the fresh one and the best match is active. Once they have stepped, what
 * they have already walked past — everything up to and including the active
 * match — stays where it is, and new arrivals queue up behind it.
 */
export function orderMatches(
  shown: readonly SmartFindMatch[],
  active: number,
  pinned: boolean,
  fresh: readonly SmartFindMatch[],
): { matches: SmartFindMatch[]; active: number } {
  if (!pinned || shown.length === 0 || active < 0) return { matches: [...fresh], active: fresh.length > 0 ? 0 : -1 };
  const latest = new Map(fresh.map((match) => [keyOf(match), match]));
  const kept = shown.slice(0, active + 1).map((match) => latest.get(keyOf(match)) ?? match);
  const keys = new Set(kept.map(keyOf));
  return { matches: [...kept, ...fresh.filter((match) => !keys.has(keyOf(match)))], active };
}
