/**
 * What each `/` row does to the document (docs/notes.md §5). The catalog is
 * pure (slash.ts); this is the editor half, kept apart so the rows can be
 * tested without one.
 */

import type { Editor, Range } from "@tiptap/core";
import type { SlashCommand } from "./slash";

/** The follow-ups that need more than the document: the Image prompt (an address, or a file). */
export interface SlashActions {
  promptImage(): void;
}

export function runSlashCommand(editor: Editor, command: SlashCommand, range: Range, actions: SlashActions): void {
  // Every row first removes the typed `/query`.
  const chain = editor.chain().focus().deleteRange(range);
  switch (command.id) {
    case "paragraph":
      chain.clearNodes().run();
      break;
    case "heading1":
      chain.setHeading({ level: 1 }).run();
      break;
    case "heading2":
      chain.setHeading({ level: 2 }).run();
      break;
    case "heading3":
      chain.setHeading({ level: 3 }).run();
      break;
    case "bulletList":
      if (editor.isActive("bulletList")) chain.run();
      else chain.toggleBulletList().run();
      break;
    case "orderedList":
      if (editor.isActive("orderedList")) chain.run();
      else chain.toggleOrderedList().run();
      break;
    case "taskList":
      if (editor.isActive("taskList")) chain.run();
      else chain.toggleTaskList().run();
      break;
    case "toggle":
      // Starts open, so Enter in the title continues inside the toggle.
      chain.setDetails().updateAttributes("details", { open: true }).run();
      break;
    case "blockquote":
      chain.setBlockquote().run();
      break;
    case "callout":
      chain.setCallout().run();
      break;
    case "codeBlock":
      chain.setCodeBlock().run();
      break;
    case "divider":
      chain.setHorizontalRule().run();
      break;
    case "table":
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      break;
    case "image":
      chain.run();
      actions.promptImage();
      break;
    case "embed":
      chain.insertContent({ type: "embed" }).run();
      break;
    case "htmlBlock":
      chain.insertHtmlBlock("").run();
      break;
  }
}
