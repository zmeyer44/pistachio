/**
 * The windows the shell draws itself (docs/desk-documents.md §2): what each
 * kind shows in a desk window's frame and page. The engine knows a window
 * only by its id (lib/desk/windows.ts), and the frame — moving, resizing,
 * filling, putting away — is the same for every window; a kind adds its
 * title, its page, and any controls of its own.
 *
 * A new kind of window: its id prefix (lib/desk/windows.ts), its subject
 * here (what the surface hands its window: the thing it shows), its parts
 * (shellWindowParts), its home in the dock (DeskEngine.attachHome), and
 * what choosing and closing one mean (DeskSurface's host).
 */

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { GroupContextFile } from "@pistachio/shell-contracts/desk-agent";
import { cn } from "../../lib/cn";
import { saveLabel, useFileWindow } from "../../lib/desk/group-files";
import { FileGlyph, fileKindLabel } from "./files/FileGlyph";
import { FileWindow } from "./files/FileWindow";

/** A document's window: its group's context file, or null while the context loads. */
export interface DeskFileSubject {
  kind: "file";
  groupId: string;
  item: (GroupContextFile & { here: boolean }) | null;
  /** Open the file in the app the Mac opens it with. */
  openElsewhere(): void;
}

/** What a shell window shows, by its kind (one kind today). */
export type ShellWindowSubject = DeskFileSubject;

export interface ShellWindowAction {
  label: string;
  testId: string;
  icon: ReactNode;
  run(): void;
}

export interface ShellWindowParts {
  /** Its name, for the window's label. */
  name: string;
  /** The frame's title: a mark, the name, and what it says of itself. */
  title(className?: string): ReactNode;
  /** Its page: the shell's own working DOM (a press on it keeps its pointer). */
  page: ReactNode;
  /** Controls ahead of fill and put away. */
  actions: ShellWindowAction[];
}

export function shellWindowParts(subject: ShellWindowSubject, windowId: string, focused: boolean): ShellWindowParts {
  switch (subject.kind) {
    case "file":
      return {
        name: subject.item?.name ?? "Document",
        title: (className) => <DocumentTitle windowId={windowId} item={subject.item} className={className} />,
        page: <FileWindow windowId={windowId} groupId={subject.groupId} item={subject.item} focused={focused} />,
        actions:
          subject.item?.here === true
            ? [{ label: "Open in its app", testId: "desk-open-elsewhere", icon: <ExternalLink aria-hidden="true" />, run: () => subject.openElsewhere() }]
            : [],
      };
  }
}

/**
 * A document window's title: its file's glyph and name, and what its
 * viewer says (its pages, its size) or where its edits stand (saving,
 * saved, not saved). Its own component, so a save's progress re-renders
 * only this.
 */
function DocumentTitle({ windowId, item, className }: { windowId: string; item: DeskFileSubject["item"]; className?: string }) {
  const state = useFileWindow(windowId);
  const saved = saveLabel(state.save);
  const detail = saved ?? state.detail ?? (item === null ? null : fileKindLabel(item.mediaType, item.name));
  return (
    <span className={cn("desk-window-title", className)} data-testid="desk-window-title" title={state.message ?? item?.name}>
      {item === null ? null : <FileGlyph mediaType={item.mediaType} className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate font-medium text-gray-1000">{item?.name ?? "Document"}</span>
      {detail === null ? null : (
        <span className="desk-window-host min-w-0 shrink-[2] truncate" data-testid="desk-window-detail" data-save={state.save}>
          {detail}
        </span>
      )}
    </span>
  );
}
