/**
 * The recipes every floating piece of the editor shares: the panel a menu
 * wears, a row in it, and keyboard focus. The same measures as the shell's
 * address palette, restated here so a list of things to pick reads the same
 * in a note wherever the note is being written.
 */

import type { ReferenceType } from "@floating-ui/react";

export const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
/** Every floating panel in a note: the slash menu, the bubble menu, a block's menu, a prompt. */
export const NOTE_PANEL_CLASS = "z-50 flex flex-col rounded-xl bg-background-100 p-1 text-gray-1000 shadow-menu";
/** One row of a list to pick from, as the address palette draws it. */
export const PALETTE_ROW_CLASS = "flex h-9 w-full cursor-pointer items-center gap-3 rounded-[10px] px-2.5 text-left transition-colors duration-100";
/** A drawn mark (a row's icon): bare ink in the 20px slot, no tile. */
export const PALETTE_GLYPH_CLASS = "grid size-5 shrink-0 place-items-center text-gray-1000 [&_svg]:size-[18px] [&_svg]:stroke-[1.75]";
export const PALETTE_TITLE_CLASS = "max-w-[62%] shrink-0 truncate text-[14px] font-medium text-gray-1000";

/**
 * A rectangle in the page as something @floating-ui can hang a panel off:
 * how both the slash menu (the caret) and the bubble menu (the selection)
 * are positioned, since neither has an element of its own.
 */
export function rectReference(rect: DOMRect | null): ReferenceType | null {
  if (rect === null) return null;
  return { getBoundingClientRect: () => rect };
}
