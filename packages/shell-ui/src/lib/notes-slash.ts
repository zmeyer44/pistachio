/**
 * What `/` offers in a note (docs/notes.md §5). A catalog rather than a
 * toolbar: the person types what they want the block to be, and the same
 * fuzzy ranker the address palette uses (lib/fuzzy.ts) finds it, so "todo",
 * "check" and "tick" all land on the to-do list.
 *
 * Pure, and free of React: the menu renders these rows, the editor runs them.
 */

import { rankFuzzy, type FuzzyCandidate } from "./fuzzy";

/** The lucide component the menu draws for a row (components/notes/SlashMenu.tsx). */
export type SlashIcon =
  | "Type"
  | "Heading1"
  | "Heading2"
  | "Heading3"
  | "List"
  | "ListOrdered"
  | "ListTodo"
  | "TextQuote"
  | "Code"
  | "Minus"
  | "Table"
  | "Image";

export type SlashGroup = "Basic" | "Lists" | "Blocks";

export type SlashCommandId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "divider"
  | "table"
  | "image";

export interface SlashCommand {
  id: SlashCommandId;
  title: string;
  /** Other words for the same thing; the ranker reads them as text. */
  keywords: readonly string[];
  group: SlashGroup;
  icon: SlashIcon;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "paragraph", title: "Text", keywords: ["paragraph", "plain", "body", "normal"], group: "Basic", icon: "Type" },
  { id: "heading1", title: "Heading 1", keywords: ["h1", "title", "big heading"], group: "Basic", icon: "Heading1" },
  { id: "heading2", title: "Heading 2", keywords: ["h2", "subtitle", "section"], group: "Basic", icon: "Heading2" },
  { id: "heading3", title: "Heading 3", keywords: ["h3", "subsection"], group: "Basic", icon: "Heading3" },
  { id: "bulletList", title: "Bulleted list", keywords: ["bullet", "unordered", "points", "ul"], group: "Lists", icon: "List" },
  { id: "orderedList", title: "Numbered list", keywords: ["ordered", "numbers", "steps", "ol"], group: "Lists", icon: "ListOrdered" },
  { id: "taskList", title: "To-do list", keywords: ["todo", "task", "checkbox", "check", "tick"], group: "Lists", icon: "ListTodo" },
  { id: "blockquote", title: "Quote", keywords: ["blockquote", "cite", "quotation"], group: "Blocks", icon: "TextQuote" },
  { id: "codeBlock", title: "Code block", keywords: ["code", "snippet", "monospace", "pre"], group: "Blocks", icon: "Code" },
  { id: "divider", title: "Divider", keywords: ["divider", "rule", "separator", "hr", "line"], group: "Blocks", icon: "Minus" },
  { id: "table", title: "Table", keywords: ["table", "grid", "rows", "columns"], group: "Blocks", icon: "Table" },
  { id: "image", title: "Image", keywords: ["image", "picture", "photo", "upload", "screenshot"], group: "Blocks", icon: "Image" },
];

/** At most this many rows: the menu is a list to glance at, not to scroll. */
export const SLASH_LIMIT = 8;

/**
 * The rows `/query` should show, best first. An empty query is the whole
 * catalog in declaration order — the person has not said anything yet, so
 * nothing has earned the top.
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const needle = query.trim();
  if (needle === "") return [...SLASH_COMMANDS].slice(0, SLASH_LIMIT);
  const candidates: FuzzyCandidate<SlashCommand>[] = SLASH_COMMANDS.map((command) => ({
    item: command,
    text: command.title,
    keywords: command.keywords,
  }));
  return rankFuzzy(needle, candidates, SLASH_LIMIT).map((match) => match.item);
}

/**
 * Whether a `/` typed at this offset opens the menu: at the start of a line,
 * or after whitespace. Mid-word — a path, a date, a fraction — it is a slash.
 */
export function slashOpensMenu(textBefore: string): boolean {
  return textBefore === "" || /\s$/u.test(textBefore);
}
