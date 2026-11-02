export interface FuzzyCandidate<T> {
  item: T;
  text: string;
  keywords?: readonly string[];
  /** Small source-specific tie breaker; textual relevance remains dominant. */
  priority?: number;
}

export interface FuzzyMatch<T> {
  item: T;
  score: number;
}

/** Scores used by callers to decide whether a result should beat web search. */
export const STRONG_FUZZY_SCORE = 700;

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function wordBoundary(text: string, index: number): boolean {
  return index === 0 || !/[a-z0-9]/.test(text[index - 1] ?? "");
}

function scoreToken(needle: string, text: string): number | null {
  if (needle === text) return 1_200;
  if (text.startsWith(needle))
    return 1_000 - Math.min(120, text.length - needle.length);
  const containedAt = text.indexOf(needle);
  if (containedAt >= 0)
    return (
      (wordBoundary(text, containedAt) ? 900 : 760) -
      Math.min(180, containedAt * 2)
    );
  if (needle.length < 2) return null;

  let at = -1;
  let previous = -2;
  let score = 280;
  for (const character of needle) {
    at = text.indexOf(character, at + 1);
    if (at < 0) return null;
    if (at === previous + 1) score += 28;
    else score -= Math.min(36, Math.max(0, at - previous - 1) * 3);
    if (wordBoundary(text, at)) score += 24;
    previous = at;
  }
  return score - Math.min(80, text.length - needle.length);
}

/**
 * Rank a mixed command inventory. Every query token must match at least one
 * field, while contiguous and word-start matches decisively beat subsequences.
 */
export function rankFuzzy<T>(
  query: string,
  candidates: readonly FuzzyCandidate<T>[],
  limit = 18,
): FuzzyMatch<T>[] {
  const needle = normalized(query);
  if (needle === "") return [];
  const tokens = needle.split(" ");
  const matches: Array<FuzzyMatch<T> & { order: number }> = [];

  candidates.forEach((candidate, order) => {
    const fields = [candidate.text, ...(candidate.keywords ?? [])]
      .map(normalized)
      .filter(Boolean);
    const tokenScores = tokens.map((token) => {
      let best: number | null = null;
      for (const field of fields) {
        const score = scoreToken(token, field);
        if (score !== null && (best === null || score > best)) best = score;
      }
      return best;
    });
    if (tokenScores.some((score) => score === null)) return;
    const whole = fields.reduce<number | null>((best, field) => {
      const score = scoreToken(needle, field);
      return score !== null && (best === null || score > best) ? score : best;
    }, null);
    const tokenTotal =
      tokenScores.reduce<number>((sum, score) => sum + (score ?? 0), 0) /
      tokens.length;
    matches.push({
      item: candidate.item,
      score: Math.round(
        tokenTotal +
          (whole === null ? 0 : whole * 0.16) +
          (candidate.priority ?? 0),
      ),
      order,
    });
  });

  return matches
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, limit)
    .map(({ item, score }) => ({ item, score }));
}
