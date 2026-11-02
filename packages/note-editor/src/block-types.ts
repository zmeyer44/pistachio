/**
 * "Turn into" targets shared by the bubble menu and the block menu
 * (docs/notes.md §5): every kind of block a textblock can become, how to
 * tell which one the caret is in, and how to make it so.
 */

import { findParentNode, type ChainedCommands, type Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import {
  Heading1,
  Heading2,
  Heading3,
  Lightbulb,
  List,
  ListCollapse,
  ListOrdered,
  ListTodo,
  Quote,
  SquareCode,
  Type,
  type LucideIcon,
} from "lucide-react";

export interface BlockType {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Markdown shortcut shown as a hint. */
  hint?: string;
  isActive: (editor: Editor) => boolean;
  /** Converts the block(s) under the current selection. */
  apply: (editor: Editor) => boolean;
}

/** The list item a position is inside, by its node name, or null. */
function listItemAround($pos: ResolvedPos): string | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const name = $pos.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") return name;
  }
  return null;
}

/**
 * Replaces the current textblock with a toggle whose summary is its text.
 * Out of any list first: a list item holds its paragraph, and a toggle put
 * in the paragraph's place would leave a blank bullet with the toggle inside.
 */
function turnIntoToggle(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  if (!$from.parent.isTextblock || $from.parent.type.name === "detailsSummary") return false;
  return editor
    .chain()
    .focus()
    .command(({ tr, commands }) => {
      for (let guard = 0; guard < 8; guard += 1) {
        const item = listItemAround(tr.selection.$from);
        if (item === null || !commands.liftListItem(item)) break;
      }
      return true;
    })
    .command(({ tr, state }) => {
      const $at = tr.selection.$from;
      const block = $at.parent;
      if (!block.isTextblock) return false;
      const nodes = state.schema.nodes;
      const toggle = nodes["details"]!.create({ open: true }, [
        nodes["detailsSummary"]!.create(null, block.content),
        nodes["detailsContent"]!.create(null, nodes["paragraph"]!.create()),
      ]);
      const from = $at.before();
      tr.replaceWith(from, $at.after(), toggle);
      // The caret at the end of the title, where it was in the paragraph's text.
      tr.setSelection(TextSelection.create(tr.doc, from + 2 + block.content.size));
      return true;
    })
    .run();
}

/**
 * Where a conversion starts: outside the toggle the selection is in, if it
 * is in one, with the caret on what was the toggle's title. A toggle "turned
 * into" a heading is its title as a heading with its blocks following as
 * siblings; `clearNodes` alone would leave the details, summary and content
 * wrappers standing around the converted paragraph.
 */
function leavingToggle(editor: Editor): ChainedCommands {
  const chain = editor.chain().focus();
  const toggle = findParentNode((node) => node.type.name === "details")(editor.state.selection);
  if (toggle === undefined) return chain;
  // The lifted title starts where the toggle did.
  return chain.unsetDetails().setTextSelection(toggle.pos + 1);
}

export const BLOCK_TYPES: BlockType[] = [
  {
    id: "paragraph",
    label: "Text",
    icon: Type,
    isActive: (e) => e.isActive("paragraph") && !e.isActive("bulletList") && !e.isActive("orderedList") && !e.isActive("taskList"),
    apply: (e) => leavingToggle(e).clearNodes().run(),
  },
  ...([1, 2, 3] as const).map<BlockType>((level) => ({
    id: `heading${String(level)}`,
    label: `Heading ${String(level)}`,
    icon: [Heading1, Heading2, Heading3][level - 1]!,
    hint: "#".repeat(level),
    isActive: (e) => e.isActive("heading", { level }),
    apply: (e) => leavingToggle(e).clearNodes().setHeading({ level }).run(),
  })),
  {
    id: "bulletList",
    label: "Bulleted list",
    icon: List,
    hint: "-",
    isActive: (e) => e.isActive("bulletList"),
    apply: (e) => leavingToggle(e).clearNodes().toggleBulletList().run(),
  },
  {
    id: "orderedList",
    label: "Numbered list",
    icon: ListOrdered,
    hint: "1.",
    isActive: (e) => e.isActive("orderedList"),
    apply: (e) => leavingToggle(e).clearNodes().toggleOrderedList().run(),
  },
  {
    id: "taskList",
    label: "To-do list",
    icon: ListTodo,
    hint: "[]",
    isActive: (e) => e.isActive("taskList"),
    apply: (e) => leavingToggle(e).clearNodes().toggleTaskList().run(),
  },
  {
    id: "details",
    label: "Toggle",
    icon: ListCollapse,
    isActive: (e) => e.isActive("details"),
    apply: turnIntoToggle,
  },
  {
    id: "blockquote",
    label: "Quote",
    icon: Quote,
    hint: ">",
    isActive: (e) => e.isActive("blockquote"),
    apply: (e) => leavingToggle(e).clearNodes().setBlockquote().run(),
  },
  {
    id: "callout",
    label: "Callout",
    icon: Lightbulb,
    isActive: (e) => e.isActive("callout"),
    apply: (e) => leavingToggle(e).clearNodes().setCallout().run(),
  },
  {
    id: "codeBlock",
    label: "Code",
    icon: SquareCode,
    hint: "```",
    isActive: (e) => e.isActive("codeBlock"),
    apply: (e) => leavingToggle(e).clearNodes().setCodeBlock().run(),
  },
];

/** The most specific block type at the selection, for labels like "Text ▾". */
export function activeBlockType(editor: Editor): BlockType {
  const priority = ["codeBlock", "heading1", "heading2", "heading3", "taskList", "bulletList", "orderedList", "callout", "blockquote", "details"];
  for (const id of priority) {
    const type = BLOCK_TYPES.find((t) => t.id === id);
    if (type !== undefined && type.isActive(editor)) return type;
  }
  return BLOCK_TYPES[0]!;
}
