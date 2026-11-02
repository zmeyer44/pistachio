/**
 * The shared, React-free document schema (docs/notes.md §5). The mounted
 * editor and the standalone converters build from the same list, so what the
 * editor keeps and what `htmlToMarkdown` says agree on every node. Node views
 * are swapped in by the editor through `overrides` (matched by extension
 * name); editor-only behaviour (menus, shortcuts, plugins) is appended through
 * `extra`.
 *
 * Nothing here needs a DOM to be *declared*: keyboard shortcuts and plugins
 * only run once an editor mounts them, so the same list builds the schema on
 * the desktop's main process and on the cloud worker.
 */

import {
  Extension,
  flattenExtensions,
  getSchema,
  type AnyExtension,
  type Mark,
  type MarkdownParseHelpers,
  type MarkdownToken,
} from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { renderTableToMarkdown, Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import type { Schema } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import { BlockShortcuts, HeadingBackspace, KeepTabInEditor, NoteListKeymap } from "./keymap.js";
import { Callout, calloutFromBlockquoteToken, calloutQuoteTokenizer } from "./nodes/callout.js";
import { Embed } from "./nodes/embed.js";
import { HtmlBlock, isLiveHtmlFence } from "./nodes/html-block.js";
import { Toggle, ToggleContent, ToggleSummary } from "./nodes/toggle.js";
import { NotePlaceholder } from "./placeholder.js";

export const DEFAULT_PLACEHOLDER = "Type '/' for commands…";

// Markdown import bridges.
// An emoji/alert blockquote gets its own token type and becomes a callout.
// (Reusing the "blockquote" token name would also shadow the blockquote
// renderer: the manager resolves renderers through parse registrations first.)
const CalloutQuoteMarkdown = Extension.create({
  name: "calloutQuoteMarkdown",
  markdownTokenName: "calloutQuote",
  markdownTokenizer: calloutQuoteTokenizer,
  parseMarkdown: (token, h) =>
    calloutFromBlockquoteToken(token, h) ?? h.createNode("blockquote", undefined, h.parseChildren(token.tokens ?? [])),
});

// Parsers for a token are tried in priority order until one returns content,
// so this claims ```html live fences and leaves other fences to the code block.
const HtmlBlockMarkdownBridge = Extension.create({
  name: "htmlBlockMarkdownBridge",
  priority: 101,
  markdownTokenName: "code",
  parseMarkdown: (token, h) => (isLiveHtmlFence(token.lang) ? h.createNode("htmlBlock", { html: token.text ?? "" }) : []),
});

// The table node serializes its rows and cells itself (GFM). These fallbacks
// only exist so that no node type can silently vanish from an export.
const NoteTableRow = TableRow.extend({
  renderMarkdown: (node, h) => `| ${(node.content ?? []).map((cell) => h.renderChildren(cell.content ?? [], " ")).join(" | ")} |`,
});
const NoteTableCell = TableCell.extend({
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], " "),
});
const NoteTableHeader = TableHeader.extend({
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], " "),
});

// GFM table whose separator row lines up with its columns: the stock renderer
// adds alignment colons on top of the column width (`| ------: |`).
const NoteTable = Table.extend({
  renderMarkdown: (node, h) =>
    renderTableToMarkdown(node, h).replace(/^(\|(?: *:?-+:? *\|)+)$/mu, (row) =>
      row.replace(/(:?)(-+)(:?)/gu, (_m, left: string, dashes: string, right: string) =>
        `${left}${"-".repeat(Math.max(1, dashes.length - left.length - right.length))}${right}`,
      ),
    ),
});

// StarterKit members we re-tune are taken from it, turned off in its config,
// and listed on their own below.
const starterKitMembers = flattenExtensions([StarterKit]);
const stock = (name: string): AnyExtension => {
  const found = starterKitMembers.find((ext) => ext.name === name);
  if (found === undefined) throw new Error(`StarterKit has no ${name}`);
  return found;
};

// Code blocks (configured here, outside StarterKit, so the editor can swap in
// its node view by name): Tab indents inside code instead of leaving the page.
export const CodeBlock = stock("codeBlock");
export const CODE_BLOCK_OPTIONS = { enableTabIndentation: true, tabSize: 2 } as const;

// H4–H6 from pasted or imported HTML or markdown become H3 instead of plain text.
const Heading = stock("heading").extend({
  parseHTML: () => [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${String(level)}`, attrs: { level: Math.min(level, 3) } })),
  parseMarkdown: (token: MarkdownToken, h: MarkdownParseHelpers) =>
    h.createNode("heading", { level: Math.min(Number(token["depth"]) || 1, 3) }, h.parseInline(token.tokens ?? [])),
});

// Underline exports as `<u>…</u>`, which GitHub and most renderers display
// (the stock `++…++` is not markdown anywhere else). Both forms import.
const Underline = (stock("underline") as Mark).extend({
  renderMarkdown: (node, h) => `<u>${h.renderChildren(node)}</u>`,
});

// `++text++`, as the editor wrote underline before `<u>`: the notes a person
// already has carry it, so it imports still — a token of its own, since the
// mark's tokenizer is the `<u>` one. Not `C++` or `++i`: the delimiters hold
// text that starts and ends with something other than a space.
const LegacyUnderlineMarkdown = Extension.create({
  name: "legacyUnderlineMarkdown",
  markdownTokenName: "legacyUnderline",
  markdownTokenizer: {
    name: "legacyUnderline",
    level: "inline",
    start: (src: string) => src.indexOf("++"),
    tokenize: (src: string, _tokens: MarkdownToken[], lexer: { inlineTokens: (text: string) => MarkdownToken[] }) => {
      const match = /^\+\+(?!\s)([^\n]*?[^\s\\])\+\+/u.exec(src);
      if (match === null) return undefined;
      const text = match[1]!;
      return { type: "legacyUnderline", raw: match[0], text, tokens: lexer.inlineTokens(text) };
    },
  },
  parseMarkdown: (token: MarkdownToken, h: MarkdownParseHelpers) => h.applyMark("underline", h.parseInline(token.tokens ?? [])),
});

export interface NoteExtensionOptions {
  /** Adds the placeholder decoration (editor only). */
  placeholder?: string;
  /** Replace schema extensions of the same name, e.g. with node-view variants. */
  overrides?: AnyExtension[];
  /** Appended editor-only behaviour (menus, shortcuts, plugins). */
  extra?: AnyExtension[];
}

/** What a note may contain, and how each piece reads and writes itself. */
export function noteExtensions({ placeholder, overrides = [], extra = [] }: NoteExtensionOptions = {}): AnyExtension[] {
  const base: AnyExtension[] = [
    StarterKit.configure({
      heading: false,
      underline: false,
      // Replaced by NoteListKeymap (see keymap.ts).
      listKeymap: false,
      link: {
        // The href is followed through the shell (Mod-click), never by the
        // editor: a note is a document being written, not a page.
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        HTMLAttributes: { rel: "noopener noreferrer" },
      },
      // Where a dragged block will land: drawn by `.note-drop-cursor` in the
      // shell's tokens rather than the plugin's own black hairline.
      dropcursor: { color: false, width: 3, class: "note-drop-cursor" },
      codeBlock: false,
    }),
    Heading.configure({ levels: [1, 2, 3] }),
    CodeBlock.configure(CODE_BLOCK_OPTIONS),
    Underline,
    NoteListKeymap,
    HeadingBackspace,
    KeepTabInEditor,
    BlockShortcuts,
    TaskList,
    TaskItem.configure({ nested: true }),
    NoteTable.configure({ resizable: true, cellMinWidth: 80, lastColumnResizable: false }),
    NoteTableRow,
    NoteTableHeader,
    NoteTableCell,
    // A note's `src` is `note-blob:<id>` (N3); the editor's node view resolves
    // it. Base64 is refused so a pasted picture goes through the blob pipeline.
    Image.configure({ inline: false, allowBase64: false }),
    Callout,
    Toggle,
    ToggleSummary,
    ToggleContent,
    Embed,
    HtmlBlock,
    CalloutQuoteMarkdown,
    HtmlBlockMarkdownBridge,
    LegacyUnderlineMarkdown,
  ];

  const byName = new Map(overrides.map((ext) => [ext.name, ext]));
  const extensions = base.map((ext) => byName.get(ext.name) ?? ext);
  if (placeholder !== undefined) extensions.push(NotePlaceholder.configure({ placeholder }));
  return [...extensions, ...extra];
}

let cachedSchema: Schema | null = null;

/** The ProseMirror schema built from the shared extensions (cached). */
export function noteSchema(): Schema {
  return (cachedSchema ??= getSchema(noteExtensions()));
}
