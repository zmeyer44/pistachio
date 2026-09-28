/**
 * How a streamed reply is paced on screen. Pure.
 *
 * A model's words arrive in bursts — a publish every few dozen
 * milliseconds carrying however many tokens landed — and shown as they
 * arrive the text jerks forward a clause at a time. The chat shows a
 * PREFIX instead and advances it every frame at a rate that follows the
 * backlog: quick when far behind, unhurried when nearly caught up, never
 * slower than a reading pace, so the reply flows and still ends within a
 * few hundred milliseconds of its last word.
 */

/** The slowest the reveal runs, in characters per second, so a trickle still reads as live. */
export const MIN_CHARS_PER_SECOND = 90;
/** How much of the backlog is cleared per second: the reveal closes ~six times the gap each second. */
export const CATCH_UP_PER_SECOND = 6;
/** With the stream over, the rest is shown at this pace — quick, but not a jump. */
export const SETTLE_CHARS_PER_SECOND = 1_400;

/**
 * Where the reveal stands after `elapsedMs` more milliseconds: the number
 * of characters of `target` to show, given `shown` were showing. A target
 * shorter than what is shown (a new step's fresh reply) snaps back to it.
 */
export function advanceReveal(shown: number, target: number, elapsedMs: number, streaming: boolean): number {
  if (target <= shown) return target;
  const backlog = target - shown;
  const perSecond = streaming
    ? Math.max(MIN_CHARS_PER_SECOND, backlog * CATCH_UP_PER_SECOND)
    : Math.max(SETTLE_CHARS_PER_SECOND, backlog * CATCH_UP_PER_SECOND);
  const step = Math.max(1, Math.round((perSecond * elapsedMs) / 1000));
  return Math.min(target, shown + step);
}

/**
 * A cut through `text` at `length` that never splits a surrogate pair or a
 * word's own letters: the reveal lands on the end of a word or on a space,
 * unless the rest of the text is that one word.
 */
export function revealCut(text: string, length: number): number {
  if (length >= text.length) return text.length;
  let cut = length;
  // Not inside a surrogate pair.
  const code = text.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  // Back to the last word boundary, when the text goes on past it.
  const before = text.slice(0, cut);
  const boundary = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"));
  if (boundary <= 0) return cut;
  return /\s/u.test(text.charAt(cut)) ? cut : boundary + 1;
}
