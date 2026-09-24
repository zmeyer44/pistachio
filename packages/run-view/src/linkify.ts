/**
 * Split chat text into plain runs and clickable web links. Pure.
 *
 * Only the protocols a Glance accepts become links — http(s), the app's own
 * pistachio:// pages, and bare `www.` hosts — so a stray "node.js" in prose
 * stays text. Punctuation that merely ends the sentence is left outside the
 * link, as is a closing bracket that has no partner inside the URL.
 */

export type TextPart =
  | { type: "text"; value: string }
  | { type: "link"; href: string; label: string };

const URL_RE = /\b(?:https?:\/\/|pistachio:\/\/|www\.)[^\s<>"'`]+/gi;
const LINK_PROTOCOLS = new Set(["http:", "https:", "pistachio:"]);
const TRAILING_PUNCTUATION = /[.,;:!?'"]$/;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function count(text: string, char: string): number {
  let total = 0;
  for (const c of text) if (c === char) total += 1;
  return total;
}

/** Peel sentence punctuation and unbalanced closers off the end of a match. */
function trimLink(raw: string): string {
  let link = raw;
  for (;;) {
    const last = link.at(-1) ?? "";
    if (TRAILING_PUNCTUATION.test(last)) link = link.slice(0, -1);
    else if (last in CLOSERS && count(link, CLOSERS[last] ?? "") < count(link, last)) link = link.slice(0, -1);
    else return link;
  }
}

function hrefOf(label: string): string | null {
  const candidate = /^www\./i.test(label) ? `https://${label}` : label;
  try {
    const url = new URL(candidate);
    if (!LINK_PROTOCOLS.has(url.protocol)) return null;
    if (url.hostname === "") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  const pushText = (value: string): void => {
    if (value === "") return;
    const previous = parts.at(-1);
    if (previous?.type === "text") previous.value += value;
    else parts.push({ type: "text", value });
  };
  for (const match of text.matchAll(URL_RE)) {
    const label = trimLink(match[0]);
    const href = label === "" ? null : hrefOf(label);
    if (href === null) continue;
    pushText(text.slice(cursor, match.index));
    parts.push({ type: "link", href, label });
    cursor = match.index + label.length;
  }
  pushText(text.slice(cursor));
  return parts;
}
