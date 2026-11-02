/**
 * A callout in the editor: the emoji is a button that opens a small picker;
 * the blocks inside are the person's to edit.
 */

import { autoUpdate, flip, offset, shift, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import { CALLOUT_EMOJI_PRESETS, DEFAULT_CALLOUT_EMOJI } from "@pistachio/notes";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { cn } from "../cn";
import { NOTE_PANEL_CLASS } from "../parts";
import { useIsEditable } from "./use-is-editable";

export function CalloutView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const emoji = (node.attrs["emoji"] as string | undefined) ?? DEFAULT_CALLOUT_EMOJI;
  const editable = useIsEditable(editor);
  const [open, setOpen] = useState(false);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [picker, setPicker] = useState<HTMLDivElement | null>(null);
  const { floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    elements: { reference: button, floating: picker },
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([useDismiss(context)]);

  const pick = (next: string) => {
    updateAttributes({ emoji: next });
    setOpen(false);
  };

  return (
    <NodeViewWrapper className="note-callout" data-type="callout" data-emoji={emoji} data-testid="note-callout">
      <button
        type="button"
        ref={setButton}
        className="note-callout__emoji"
        contentEditable={false}
        disabled={!editable}
        aria-label="Change callout icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        {...getReferenceProps({ onClick: () => setOpen((value) => !value) })}
      >
        {emoji}
      </button>
      {open ? (
        <div
          ref={setPicker}
          style={floatingStyles}
          contentEditable={false}
          className={cn(NOTE_PANEL_CLASS, "grid w-auto grid-cols-8 gap-0.5 p-1.5")}
          role="dialog"
          aria-label="Callout icon"
          {...getFloatingProps()}
        >
          {CALLOUT_EMOJI_PRESETS.map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                "grid size-8 cursor-pointer place-items-center rounded-md text-[18px] transition-colors hover:bg-alpha-200",
                option === emoji && "bg-alpha-200",
              )}
              aria-label={`Use ${option}`}
              onClick={() => pick(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <NodeViewContent className="note-callout__content" />
    </NodeViewWrapper>
  );
}
