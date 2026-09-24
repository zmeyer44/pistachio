/**
 * Saved text, drawn as the app draws prose. A block is one of the few shapes
 * the extractor writes — heading, quote, fenced code, a merged list or table,
 * a paragraph — and every character of it is rendered as text: this is
 * content from a web page, so nothing here is ever markup.
 */

import { cn } from "../../lib/cn";

const HEADING = [
  "text-heading-20 mt-8 first:mt-0",
  "text-heading-16 mt-7 first:mt-0",
  "text-heading-14 mt-6 first:mt-0",
  "text-heading-14 mt-5 first:mt-0",
] as const;

export function SavedBlock({ block, tone }: { block: string; tone?: "added" | "removed" }) {
  const toned = cn(
    tone === "added" && "rounded-sm bg-green-100 px-2 py-1 text-green-1000",
    tone === "removed" && "rounded-sm bg-red-100 px-2 py-1 text-red-1000 line-through decoration-red-400",
  );
  if (block.startsWith("~~~~\n"))
    return (
      <pre className={cn("scroll-thin overflow-x-auto rounded-md bg-gray-100 px-3.5 py-3 font-mono text-[13px] leading-5 text-gray-1000 shadow-border", toned)}>
        {block.slice(5, -5)}
      </pre>
    );
  const heading = /^(#{1,6}) (.+)$/su.exec(block);
  if (heading !== null) {
    const level = Math.min(heading[1]!.length, 4);
    const Tag = `h${String(level + 1)}` as "h2" | "h3" | "h4" | "h5";
    return <Tag className={cn(HEADING[level - 1], "text-gray-1000", toned)}>{heading[2]}</Tag>;
  }
  if (block.startsWith("> "))
    return <blockquote className={cn("border-l-2 border-gray-400 pl-3.5 text-copy-14 text-gray-900", toned)}>{block.slice(2)}</blockquote>;
  const lines = block.split("\n");
  // A merged list: every line is an item the extractor bulleted or numbered.
  if (lines.length > 1 && lines.every((line) => /^(- |\d+\. )/u.test(line))) {
    const ordered = /^\d/u.test(lines[0]!);
    const List = ordered ? "ol" : "ul";
    return (
      <List className={cn("space-y-1 pl-5 text-copy-14 text-gray-1000", ordered ? "list-decimal" : "list-disc", toned)}>
        {lines.map((line, index) => (
          <li key={index} className="pl-0.5 marker:text-gray-700">
            {line.replace(/^(- |\d+\. )/u, "")}
          </li>
        ))}
      </List>
    );
  }
  // A merged table keeps its rows; anything else is a paragraph.
  return <p className={cn("text-copy-14 whitespace-pre-line text-gray-1000", toned)}>{block}</p>;
}

/** The first block is the card: title, description, creator. Drawn apart from the body. */
export function SavedCard({ block }: { block: string }) {
  const [, ...rest] = block.split("\n\n");
  if (rest.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md bg-background-200 px-3.5 py-3 shadow-border">
      {rest.map((part, index) =>
        /^(Creator|Published|Duration): /mu.test(part) ? (
          <dl key={index} className="flex flex-wrap gap-x-5 gap-y-1">
            {part.split("\n").map((line) => {
              const at = line.indexOf(": ");
              return (
                <div key={line} className="flex items-baseline gap-1.5">
                  <dt className="text-label-12 text-gray-700">{line.slice(0, at)}</dt>
                  <dd className="text-label-13 text-gray-1000">{line.slice(at + 2)}</dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p key={index} className="text-copy-13 text-gray-900">
            {part}
          </p>
        ),
      )}
    </div>
  );
}
