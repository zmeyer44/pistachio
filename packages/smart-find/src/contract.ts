/**
 * What crosses between the page, the host and the model for a smart find
 * (docs/smart-find.md). Plain data only: this file has no DOM, no Electron
 * and no model in it, so every side can import it.
 */

/** One stretch of the page's prose, as the model sees it. */
export interface SmartFindPassage {
  /** `b17`, or `b17p2` for the third part of a long block that was split. */
  id: string;
  text: string;
  /** The block a split part belongs to; parts of one block merge into one match. */
  block: string;
}

export interface SmartFindCollection {
  /** Names this reading of the page; a paint for another generation is refused. */
  generation: number;
  passages: SmartFindPassage[];
  /** The page exceeded the bounds below; only its first part was read. */
  truncated: boolean;
}

/** Character offsets into a passage's text (UTF-16, as DOM ranges count). */
export interface SmartFindSpan {
  start: number;
  end: number;
}

export interface SmartFindMatch {
  /** The passages of one block that matched, in document order. */
  ids: string[];
  /** The best of their probabilities. */
  probability: number;
  /** The key sentence, once the model has picked one: a span inside `ids[focus.part]`. */
  focus?: SmartFindSpan & { id: string };
}

export interface SmartFindPaint {
  generation: number;
  matches: { ids: string[]; focus?: SmartFindSpan & { id: string } }[];
  /** Index into `matches`, or -1 for none. */
  active: number;
  /** Scroll the active match into view; false when only the colours changed. */
  scroll: boolean;
  /** Paler colours: these are the closest passages, not confident matches. */
  weak: boolean;
}

export interface SmartFindPainted {
  /** Passage ids whose element is gone or whose text changed since the collect. */
  stale: string[];
}

/** The bounds the page script reads under. */
export const SMART_FIND_COLLECT_LIMITS = {
  passages: 600,
  chars: 240_000,
  nodes: 25_000,
  cpuMs: 150,
  /** Shorter text is a label, not a passage. */
  minChars: 12,
  /** A longer block is split on sentence boundaries. */
  splitChars: 1200,
} as const;

export const SMART_FIND_LIMITS = {
  query: 400,
  /** Small state: Jev's documented weakness is a large state full of distractors. */
  batch: 40,
  concurrency: 6,
  timeoutMs: 4000,
  /** p at or above this is a match. */
  match: 0.5,
  /** With no match, up to `closestCount` passages at or above this are offered as "closest". */
  closest: 0.25,
  closestCount: 3,
  matches: 20,
  /** How many matches get a key sentence picked. */
  focusMatches: 12,
  focusTimeoutMs: 2500,
  focusSentences: 12,
  excerpt: 160,
} as const;
