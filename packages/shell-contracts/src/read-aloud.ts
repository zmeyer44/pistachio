/**
 * "Read aloud" following: the words of a clip lit on the page they came
 * from as the voice reaches them.
 *
 * No synthesizer this app reaches reports word timings, so the timing is
 * inferred. A clip is spoken as a series of pieces (main/read-aloud.ts);
 * main measures each piece's audio, and a piece's seconds are spread over
 * its characters — a full stop or a paragraph break weighing as the pause a
 * voice takes there. Every piece re-anchors the estimate, so the drift
 * within a word never grows past one piece's worth.
 *
 * The page side (preload/tab.ts) matches the clip's words against the
 * document's text and lights the matched ranges through the CSS Custom
 * Highlight API. The matching is pure and lives here so it can be tested
 * without a document.
 */

/** Main → the source tab's isolated preload. */
export const READ_ALOUD_FOLLOW_CHANNEL = "pistachio:read-aloud-follow";

/** One spoken piece: the span of the clip's text it covers and how long it plays. */
export interface ReadAloudPieceTiming {
  charStart: number;
  charEnd: number;
  seconds: number;
}

/** What a page needs to follow a clip: the text, and how far the voice has been measured. */
export interface ReadAloudFollowScript {
  clipId: string;
  /** The prepared text, paragraphs separated by a single newline. */
  text: string;
  /** The pieces spoken so far, in order and contiguous in time. */
  pieces: ReadAloudPieceTiming[];
  /** No more pieces are coming. */
  done: boolean;
}

/** Where the player is, as the media card knows it; the page projects between updates. */
export interface ReadAloudFollowSync {
  position: number;
  playing: boolean;
  playbackRate: number;
  /** Wall-clock time of `position`. */
  updatedAt: number;
}

export type ReadAloudFollowMessage =
  | { type: "script"; script: ReadAloudFollowScript; sync: ReadAloudFollowSync | null }
  | { type: "sync"; clipId: string; sync: ReadAloudFollowSync }
  | { type: "stop" };

/* ------------------------------------------------------------------ */
/* Words and timing                                                    */
/* ------------------------------------------------------------------ */

export interface SpeechWord {
  /** Character span in the clip's text. */
  start: number;
  end: number;
  paragraph: number;
}

/** A word with the seconds it is (estimated to be) spoken over. */
export interface TimedWord extends SpeechWord {
  at: number;
  until: number;
}

/** The words of prepared text, as whitespace separates them. */
export function speechWords(text: string): SpeechWord[] {
  const words: SpeechWord[] = [];
  let paragraph = 0;
  const pattern = /\S+|\n/gu;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === "\n") {
      paragraph += 1;
      continue;
    }
    words.push({ start: match.index, end: match.index + match[0].length, paragraph });
  }
  return words;
}

/**
 * How much of a piece's time a word takes, relative to the others: its
 * letters, plus the pause a voice leaves after it.
 */
function wordWeight(text: string, word: SpeechWord, lastInParagraph: boolean): number {
  const token = text.slice(word.start, word.end);
  let weight = Math.max(1, token.replace(/[^\p{L}\p{N}]/gu, "").length);
  if (/[.!?…]["'”’)]*$/u.test(token)) weight += 4;
  else if (/[,;:]["'”’)]*$/u.test(token)) weight += 2;
  if (lastInParagraph) weight += 4;
  return weight;
}

/**
 * When each word is spoken, from the measured pieces. Words past the last
 * piece have no timing yet and are left out; the caller gets a fresh timeline
 * when more of the clip arrives.
 */
export function wordTimeline(text: string, pieces: readonly ReadAloudPieceTiming[]): TimedWord[] {
  const words = speechWords(text);
  const timeline: TimedWord[] = [];
  let clock = 0;
  let index = 0;
  for (const piece of pieces) {
    const inPiece: SpeechWord[] = [];
    while (index < words.length && (words[index]?.start ?? Number.POSITIVE_INFINITY) < piece.charEnd) {
      const word = words[index]!;
      if (word.start >= piece.charStart) inPiece.push(word);
      index += 1;
    }
    const seconds = Math.max(0, piece.seconds);
    if (inPiece.length === 0) {
      clock += seconds;
      continue;
    }
    const weights = inPiece.map((word, position) =>
      wordWeight(text, word, position === inPiece.length - 1 || inPiece[position + 1]?.paragraph !== word.paragraph),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsed = 0;
    inPiece.forEach((word, position) => {
      const at = clock + (seconds * elapsed) / total;
      elapsed += weights[position] ?? 0;
      timeline.push({ ...word, at, until: clock + (seconds * elapsed) / total });
    });
    clock += seconds;
  }
  return timeline;
}

/**
 * The word being spoken at `seconds`: the last one to have started. -1
 * before the first word. A time past the last measured word still answers
 * that word — the next piece is on its way, and a lit word that lingers
 * reads better than one that blinks out.
 */
export function timedWordAt(timeline: readonly TimedWord[], seconds: number): number {
  let low = 0;
  let high = timeline.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((timeline[middle]?.at ?? Number.POSITIVE_INFINITY) <= seconds) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Matching the clip's words to a page's                               */
/* ------------------------------------------------------------------ */

/** Letters and digits only, folded: what two renderings of one word share. */
export function normalizeSpeechToken(token: string): string {
  return token.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Consecutive unmatched clip words before a paragraph is given up on. */
const MAX_MISS_RUN = 8;
/** How far ahead in the page a word is looked for before it counts as missing. */
const RESYNC_LOOKAHEAD = 4;
/** Paragraphs at least this many words long may be found before the cursor, not just after. */
const MIN_WORDS_FOR_REWIND = 4;

/**
 * Which page token each clip word is, or -1 when the page does not have it.
 *
 * Clip and page are compared as folded tokens (`normalizeSpeechToken`), so
 * punctuation, case and typographic quotes do not get in the way. Each
 * paragraph of the clip is looked for from where the last one ended — its
 * first two real words in a row — then walked word by word, skipping a
 * page token that the clip does not have (an image's alt, a footnote mark)
 * or a clip word that the page does not, up to a point: a run of misses
 * ends the paragraph, and the next paragraph is looked for afresh. A
 * paragraph not found after the cursor is looked for from the top of the
 * page, so a title spoken last still lights up.
 */
export function matchSpeechWords(clipWords: readonly string[], paragraphs: readonly number[], pageTokens: readonly string[]): Int32Array {
  const clip = clipWords.map(normalizeSpeechToken);
  const page = pageTokens.map(normalizeSpeechToken);
  const matched = new Int32Array(clip.length).fill(-1);
  // Where each folded page token occurs, for the paragraph-start search.
  const occurrences = new Map<string, number[]>();
  page.forEach((token, index) => {
    if (token === "") return;
    const list = occurrences.get(token);
    if (list === undefined) occurrences.set(token, [index]);
    else list.push(index);
  });
  const nextRealPage = (from: number): number => {
    let index = from;
    while (index < page.length && page[index] === "") index += 1;
    return index;
  };

  // Group clip word indexes by paragraph, in order.
  const groups: number[][] = [];
  clip.forEach((token, index) => {
    if (token === "") return;
    const paragraph = paragraphs[index] ?? 0;
    const last = groups[groups.length - 1];
    if (last !== undefined && (paragraphs[last[0]!] ?? 0) === paragraph) last.push(index);
    else groups.push([index]);
  });

  let cursor = 0;
  for (const group of groups) {
    const start = findParagraphStart(group, clip, page, occurrences, nextRealPage, cursor);
    if (start === -1) continue;
    let pageIndex = start;
    let misses = 0;
    for (const clipIndex of group) {
      pageIndex = nextRealPage(pageIndex);
      const token = clip[clipIndex]!;
      let found = -1;
      for (let ahead = 0, probe = pageIndex; ahead <= RESYNC_LOOKAHEAD && probe < page.length; probe += 1) {
        if (page[probe] === "") continue;
        if (page[probe] === token) {
          found = probe;
          break;
        }
        ahead += 1;
      }
      if (found === -1) {
        misses += 1;
        if (misses > MAX_MISS_RUN) break;
        continue;
      }
      misses = 0;
      matched[clipIndex] = found;
      pageIndex = found + 1;
      cursor = pageIndex;
    }
  }
  return matched;
}

function findParagraphStart(
  group: readonly number[],
  clip: readonly string[],
  page: readonly string[],
  occurrences: ReadonlyMap<string, number[]>,
  nextRealPage: (from: number) => number,
  cursor: number,
): number {
  const lead = group.slice(0, 2).map((index) => clip[index]!);
  const candidates = occurrences.get(lead[0]!) ?? [];
  const startsHere = (position: number): boolean => {
    let probe = position;
    for (const token of lead) {
      probe = nextRealPage(probe);
      if (probe >= page.length || page[probe] !== token) return false;
      probe += 1;
    }
    return true;
  };
  for (const position of candidates) {
    if (position >= cursor && startsHere(position)) return position;
  }
  if (group.length >= MIN_WORDS_FOR_REWIND) {
    for (const position of candidates) {
      if (position < cursor && startsHere(position)) return position;
    }
  }
  return -1;
}
