/**
 * @mentions in the Bar (docs/desk-documents.md §1): a file of the group's
 * context named in a message with `@` and its name is attached to that
 * message. Pure, so the Bar's tests pin where a mention starts, which files
 * it offers, and which names in a message are mentions.
 */

/** A mention being typed: `@` at the start or after a space, and what follows it up to the caret (no line break). */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s([{"'“‘]/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  // A mention is a name: it ends at a line break, and no name starts with a space.
  if (/[\n\r]/.test(query) || query.startsWith(" ") || query.length > 80) return null;
  return { start: at, query };
}

/**
 * The mention being typed, if one is: not one already written out (a
 * file's whole name and a space — a mention accepted, or typed in full),
 * nor one the person dismissed (Escape), whose `@` is at `dismissed`.
 */
export function activeMention(text: string, caret: number, names: readonly string[], dismissed: number | null): { start: number; query: string } | null {
  const query = mentionQuery(text, caret);
  if (query === null || query.start === dismissed) return null;
  const written = names.some((name) => query.query.startsWith(name) && /^\s/.test(query.query.slice(name.length)));
  // (Unless a longer name still starts so: "@Plan B" on the way to "Plan B.pdf", past "Plan".)
  const typed = query.query.toLowerCase();
  if (written && !names.some((name) => name.toLowerCase().startsWith(typed))) return null;
  return query;
}

/** The files a query offers, best first: names that start with it, then words that do, then names that hold it. */
export function mentionCandidates<T extends { name: string }>(files: readonly T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return files.slice(0, limit);
  const scored: Array<{ file: T; score: number; index: number }> = [];
  files.forEach((file, index) => {
    const name = file.name.toLowerCase();
    const score = name.startsWith(q) ? 0 : name.split(/[\s._-]+/).some((word) => word.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1;
    if (score >= 0) scored.push({ file, score, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.file);
}

/** The text with the mention being typed replaced by the file's name, and where the caret goes (after a space). */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const inserted = `@${name}${after.startsWith(" ") ? "" : " "}`;
  return { text: `${text.slice(0, start)}${inserted}${after}`, caret: start + inserted.length + (after.startsWith(" ") ? 1 : 0) };
}

export interface MentionSpan {
  start: number;
  end: number;
  name: string;
}

/**
 * Every mention in a message: `@` and one of the names, at the start or
 * after a space or an opening bracket, and followed by the end, a space or
 * punctuation. The longest name wins where two would both fit ("@Plan" and
 * "@Plan B.pdf").
 */
export function mentionsIn(text: string, names: readonly string[]): MentionSpan[] {
  if (names.length === 0 || !text.includes("@")) return [];
  const sorted = [...new Set(names)].filter((name) => name !== "").sort((a, b) => b.length - a.length);
  const spans: MentionSpan[] = [];
  for (let index = text.indexOf("@"); index >= 0; index = text.indexOf("@", index + 1)) {
    if (index > 0 && !/[\s([{"'“‘]/.test(text[index - 1]!)) continue;
    const rest = text.slice(index + 1);
    const name = sorted.find((candidate) => rest.startsWith(candidate) && (rest.length === candidate.length || /[\s,.;:!?)\]}"'”’]/.test(rest[candidate.length]!)));
    if (name === undefined) continue;
    spans.push({ start: index, end: index + 1 + name.length, name });
    index += name.length;
  }
  return spans;
}
