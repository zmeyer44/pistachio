/**
 * What `/` offers in a note (docs/notes.md §5). A catalog rather than a
 * toolbar: the person types what they want the block to be, and the same
 * fuzzy ranker the address palette uses (shell-contracts/fuzzy.ts) finds it, so "todo",
 * "check" and "tick" all land on the to-do list.
 *
 * Pure, and free of React: the menu renders these rows, the editor runs them
 * (slash-actions.ts).
 */

import { rankFuzzy, type FuzzyCandidate } from "@pistachio/shell-contracts/fuzzy";

/** The lucide component the menu draws for a row (SlashMenu.tsx). */
export type SlashIcon =
  | "Type"
  | "Heading1"
  | "Heading2"
  | "Heading3"
  | "List"
  | "ListOrdered"
  | "ListTodo"
  | "ListCollapse"
  | "TextQuote"
  | "Lightbulb"
  | "Code"
  | "Minus"
  | "Table"
  | "Image"
  | "Globe"
  | "CodeXml";

export type SlashGroup = "Basic blocks" | "Media & advanced";

export type SlashCommandId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "toggle"
  | "blockquote"
  | "callout"
  | "codeBlock"
  | "divider"
  | "table"
  | "image"
  | "embed"
  | "htmlBlock";

export interface SlashCommand {
  id: SlashCommandId;
  title: string;
  /** Other words for the same thing; the ranker reads them as text. */
  keywords: readonly string[];
  group: SlashGroup;
  icon: SlashIcon;
  /** The markdown that makes the same block, shown as a hint. */
  hint?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "paragraph", title: "Text", keywords: ["paragraph", "plain", "body", "normal"], group: "Basic blocks", icon: "Type" },
  { id: "heading1", title: "Heading 1", keywords: ["h1", "title", "big heading"], group: "Basic blocks", icon: "Heading1", hint: "#" },
  { id: "heading2", title: "Heading 2", keywords: ["h2", "subtitle", "section"], group: "Basic blocks", icon: "Heading2", hint: "##" },
  { id: "heading3", title: "Heading 3", keywords: ["h3", "subsection"], group: "Basic blocks", icon: "Heading3", hint: "###" },
  { id: "bulletList", title: "Bulleted list", keywords: ["bullet", "unordered", "points", "ul"], group: "Basic blocks", icon: "List", hint: "-" },
  { id: "orderedList", title: "Numbered list", keywords: ["ordered", "numbers", "steps", "ol"], group: "Basic blocks", icon: "ListOrdered", hint: "1." },
  { id: "taskList", title: "To-do list", keywords: ["todo", "task", "checkbox", "check", "tick"], group: "Basic blocks", icon: "ListTodo", hint: "[]" },
  { id: "toggle", title: "Toggle", keywords: ["details", "collapse", "expand", "fold", "accordion"], group: "Basic blocks", icon: "ListCollapse" },
  { id: "blockquote", title: "Quote", keywords: ["blockquote", "cite", "quotation"], group: "Basic blocks", icon: "TextQuote", hint: ">" },
  { id: "callout", title: "Callout", keywords: ["note", "tip", "info", "warning", "aside", "highlight"], group: "Basic blocks", icon: "Lightbulb" },
  { id: "codeBlock", title: "Code", keywords: ["code", "snippet", "monospace", "pre", "codeblock"], group: "Basic blocks", icon: "Code", hint: "```" },
  { id: "divider", title: "Divider", keywords: ["divider", "rule", "separator", "hr", "line"], group: "Basic blocks", icon: "Minus", hint: "---" },
  { id: "table", title: "Table", keywords: ["table", "grid", "rows", "columns"], group: "Media & advanced", icon: "Table" },
  { id: "image", title: "Image", keywords: ["image", "picture", "photo", "upload", "screenshot"], group: "Media & advanced", icon: "Image" },
  { id: "embed", title: "Embed", keywords: ["iframe", "youtube", "loom", "figma", "video", "vimeo", "website"], group: "Media & advanced", icon: "Globe" },
  { id: "htmlBlock", title: "HTML block", keywords: ["html", "widget", "live", "script", "custom", "component"], group: "Media & advanced", icon: "CodeXml" },
];

export const SLASH_GROUPS: readonly SlashGroup[] = ["Basic blocks", "Media & advanced"];

/**
 * The rows `/query` should show, best first. An empty query is the whole
 * catalog in declaration order — the person has not said anything yet, so
 * nothing has earned the top — and the menu groups it.
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const needle = query.trim();
  if (needle === "") return [...SLASH_COMMANDS];
  const candidates: FuzzyCandidate<SlashCommand>[] = SLASH_COMMANDS.map((command) => ({
    item: command,
    text: command.title,
    keywords: command.keywords,
  }));
  return rankFuzzy(needle, candidates, SLASH_COMMANDS.length).map((match) => match.item);
}

/**
 * Whether a `/` typed at this offset opens the menu: at the start of a line,
 * or after whitespace. Mid-word — a path, a date, a fraction — it is a slash.
 */
export function slashOpensMenu(textBefore: string): boolean {
  return textBefore === "" || /\s$/u.test(textBefore);
}

/**
 * Whether the menu stays open for what has been typed after the `/`. A
 * query may hold a space ("heading 1", "html block"), as in Notion, but a
 * space first means the slash was a slash, and a spaced query that matches
 * nothing is prose carrying on.
 */
export function slashQueryShowsMenu(query: string): boolean {
  if (/^\s/u.test(query)) return false;
  return !/\s/u.test(query) || filterSlashCommands(query).length > 0;
}
