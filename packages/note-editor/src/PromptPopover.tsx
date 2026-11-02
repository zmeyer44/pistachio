/**
 * A one-line prompt anchored at a document position: the Image row's
 * "Paste a picture's address", with a second way in when the host can take a
 * file. Enter submits; the prompt stays open, with a word about why, when
 * what was typed is not what it asked for.
 */

import type { Editor } from "@tiptap/core";
import { CornerDownLeft, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "./cn";
import { FOCUS } from "./parts";
import { RangePopover } from "./RangePopover";

interface PromptPopoverProps {
  editor: Editor;
  pos: number;
  label: string;
  icon: LucideIcon;
  placeholder: string;
  /** Returns a line to show and stay open on, or nothing when the value was taken. */
  onSubmit: (value: string) => string | undefined;
  onCancel: () => void;
  /** Another way to answer the prompt — "Upload a file" — when the host has one. */
  action?: { label: string; icon: ReactNode; onClick: () => void; testId?: string } | undefined;
  testId?: string;
}

const ACTION = cn("inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[13px] text-gray-800 transition-colors hover:bg-alpha-200 hover:text-gray-1000 [&_svg]:size-3.5", FOCUS);

export function PromptPopover({ editor, pos, label, icon: Icon, placeholder, onSubmit, onCancel, action, testId }: PromptPopoverProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <RangePopover editor={editor} from={pos} to={pos} label={label} onDismiss={onCancel} testId={testId}>
      <form
        className="flex items-center gap-2 rounded-lg px-2.5 py-0.5 shadow-border focus-within:shadow-[0_0_0_1px_var(--color-gray-800)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() === "") return;
          setError(onSubmit(value.trim()) ?? null);
        }}
      >
        <Icon className="size-4 shrink-0 text-gray-800" aria-hidden="true" />
        <input
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] text-gray-1000 outline-none placeholder:text-gray-600"
          data-autofocus
          data-testid={testId === undefined ? undefined : `${testId}-input`}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={error === null ? undefined : true}
        />
        <button
          type="submit"
          className={cn("grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-gray-1000 text-background-100 disabled:cursor-default disabled:opacity-25 [&_svg]:size-3.5", FOCUS)}
          disabled={value.trim() === ""}
          aria-label="Submit"
        >
          <CornerDownLeft aria-hidden="true" />
        </button>
      </form>
      {error === null && action === undefined ? null : (
        <div className="flex items-center gap-1 pt-1.5">
          {action === undefined ? null : (
            <button type="button" className={ACTION} data-testid={action.testId} onClick={action.onClick}>
              {action.icon} {action.label}
            </button>
          )}
          {error === null ? null : <p className="ml-auto px-1 text-[12.5px] text-red-900">{error}</p>}
        </div>
      )}
    </RangePopover>
  );
}
