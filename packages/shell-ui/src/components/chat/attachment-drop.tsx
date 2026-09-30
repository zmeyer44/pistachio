import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import { Paperclip } from "lucide-react";
import { MAX_COMPOSER_ATTACHMENTS, readComposerAttachment, type ComposerAttachment } from "../../lib/chat-attachments";
import { cn } from "../../lib/cn";

/**
 * Files staged for the next message, and the drop zone that stages them:
 * the console's panel and the home chat's page are each one whole zone, so
 * a file let go anywhere on the conversation lands in its composer.
 * `focusComposer` hands the keyboard back to the field once the files are
 * in; pass a stable function.
 *
 * `depth` counts enter/leave pairs — dragging across the zone's children
 * fires leave/enter at every element boundary, and a plain boolean would
 * flicker the veil off each time. It is a ref, so only the veil showing
 * and hiding re-renders the conversation, not every boundary crossed.
 * Rejections surface in the composer rather than as a global error: the
 * shell's error banner has no dismissal and pushes the native tab views
 * down, which is far too much for "that file is too big".
 */
export function useAttachmentDrop(focusComposer: () => void) {
  const [staged, setStaged] = useState<ComposerAttachment[]>([]);
  const [rejection, setRejection] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const addFiles = useCallback(
    async (list: FileList): Promise<void> => {
      // Taken before the first await: a drop's FileList empties once its
      // event returns, and a file input's is cleared right after this call.
      const dropped = Array.from(list);
      // Read against the count at drop time; `staged` is stale inside the loop.
      let room = MAX_COMPOSER_ATTACHMENTS - staged.length;
      if (room <= 0) {
        setRejection(`At most ${String(MAX_COMPOSER_ATTACHMENTS)} files per message`);
        return;
      }
      setRejection(
        dropped.length > room ? `Attached the first ${String(room)} — at most ${String(MAX_COMPOSER_ATTACHMENTS)} files per message` : null,
      );
      for (const file of dropped) {
        if (room <= 0) break;
        try {
          const result = await readComposerAttachment(file);
          if (result.ok) {
            room -= 1;
            setStaged((prev) => [...prev, result.attachment]);
          } else {
            setRejection(result.reason);
          }
        } catch {
          setRejection(`Could not read ${file.name}`);
        }
      }
      focusComposer();
    },
    [staged.length, focusComposer],
  );

  const handlers = useMemo(() => {
    const carriesFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes("Files");
    return {
      onDragEnter: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        void addFiles(event.dataTransfer.files);
      },
    };
  }, [addFiles]);

  const dismissRejection = useCallback(() => setRejection(null), []);

  return { staged, setStaged, addFiles, rejection, reject: setRejection, dismissRejection, dragging, handlers };
}

/**
 * The drop zone's feedback while files are held over it. pointer-events-none
 * so the drop still lands on the zone underneath rather than on this veil.
 */
export function AttachmentDropVeil({ className, "data-testid": testId }: { className?: string; "data-testid"?: string }) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "animate-backdrop-in pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed border-blue-700 bg-blue-100/70",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 rounded-full bg-background-100 px-3 py-1.5 text-label-13 font-medium text-blue-900 shadow-menu">
        <Paperclip className="size-3.5" aria-hidden="true" />
        Drop files to attach
      </span>
    </div>
  );
}
