/**
 * Placeholder text for the empty block under the caret ("Type '/' for
 * commands…", "Heading 1", "List", "To-do"…).
 *
 * Replaces `@tiptap/extensions`' Placeholder, whose incremental decoration
 * field (used with includeChildren) throws while mapping through the undo of
 * a list input rule ("Position -1 outside of fragment"), leaving undo stuck,
 * and whose label callback resolves positions against the previous state, so
 * labels lag one transaction behind. One decoration for the caret's block,
 * derived from the current state, needs neither.
 */

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface NotePlaceholderOptions {
  /** Text for an empty paragraph. */
  placeholder: string;
}

/** The label for an empty textblock, or null for none (code, table cells). */
export function placeholderFor(node: PMNode, parent: PMNode | null, fallback: string): string | null {
  if (node.type.spec.code) return null;
  if (node.type.name === "heading") return `Heading ${String(node.attrs["level"])}`;
  if (node.type.name === "detailsSummary") return "Toggle";
  switch (parent?.type.name) {
    case "listItem":
      return "List";
    case "taskItem":
      return "To-do";
    case "tableCell":
    case "tableHeader":
      return null;
    default:
      return fallback;
  }
}

export const NotePlaceholder = Extension.create<NotePlaceholderOptions>({
  name: "placeholder",

  addOptions() {
    return { placeholder: "" };
  },

  addProseMirrorPlugins() {
    const { editor } = this;
    const fallback = this.options.placeholder;
    return [
      new Plugin({
        key: new PluginKey("notePlaceholder"),
        props: {
          decorations(state) {
            if (!editor.isEditable) return null;
            const { $anchor } = state.selection;
            const block = $anchor.parent;
            if (!block.isTextblock || block.content.size > 0 || $anchor.depth === 0) return null;
            const label = placeholderFor(block, $anchor.depth > 1 ? $anchor.node(-1) : null, fallback);
            if (!label) return null;
            const from = $anchor.before();
            return DecorationSet.create(state.doc, [
              Decoration.node(from, from + block.nodeSize, { class: "is-empty", "data-placeholder": label }),
            ]);
          },
        },
      }),
    ];
  },
});
