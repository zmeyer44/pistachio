/**
 * A selection kept visibly highlighted while focus is in a popover (the
 * link editor) or a block menu, where the native selection is not shown.
 * A decoration, so it never touches the stored HTML.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const pendingRangeKey = new PluginKey<DecorationSet>("notePendingRange");

export interface PendingRange {
  from: number;
  to: number;
  /** Highlight a whole block node instead of an inline text range. */
  block?: boolean;
}

export function setPendingRange(tr: Transaction, range: PendingRange | null): Transaction {
  return tr.setMeta(pendingRangeKey, range ?? false).setMeta("addToHistory", false);
}

export const PendingRangeHighlight = Extension.create({
  name: "pendingRange",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: pendingRangeKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(pendingRangeKey) as PendingRange | false | undefined;
            if (meta === false) return DecorationSet.empty;
            if (meta === undefined) return set.map(tr.mapping, tr.doc);
            const decoration =
              meta.block === true
                ? Decoration.node(meta.from, meta.to, { class: "note-block-selected" })
                : Decoration.inline(meta.from, meta.to, { class: "note-pending-selection" });
            return DecorationSet.create(tr.doc, [decoration]);
          },
        },
        props: {
          decorations: (state) => pendingRangeKey.getState(state),
        },
      }),
    ];
  },
});
