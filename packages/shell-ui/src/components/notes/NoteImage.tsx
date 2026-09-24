/**
 * A picture inside a note. Its `src` is `note-blob:<id>` (N3) — an address
 * only this app can resolve — so the node draws itself from the object URL
 * `use-notes` holds for that blob, and shows a quiet box while it is being
 * fetched. Nothing about the picture is in the markdown but its id.
 */

import { useEffect, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { ImageOff } from "lucide-react";
import { cn } from "../../lib/cn";
import { useNotes } from "./use-notes";

/** `note-blob:<24 hex>` → the id, or null for anything else. */
export function blobIdOf(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const match = /^note-blob:([a-f0-9]{24})$/u.exec(src.trim());
  return match === null ? null : match[1]!;
}

export function NoteImageView({ node, selected }: ReactNodeViewProps) {
  const src = node.attrs["src"] as string | null;
  const alt = (node.attrs["alt"] as string | null) ?? "";
  const id = blobIdOf(src);
  const cached = useNotes((state) => (id === null ? undefined : state.blobUrls[id]));
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (id === null || cached !== undefined) return;
    let live = true;
    void useNotes
      .getState()
      .blobUrl(id)
      .then((url) => {
        if (live && url === null) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [id, cached]);

  return (
    <NodeViewWrapper
      as="figure"
      data-testid="note-image"
      data-blob-id={id ?? undefined}
      className={cn("my-4 overflow-hidden rounded-lg", selected && "ring-2 ring-ring")}
    >
      {cached !== undefined ? (
        <img src={cached} alt={alt} draggable={false} className="block max-w-full rounded-lg" />
      ) : missing || id === null ? (
        <span className="flex h-24 items-center justify-center gap-2 rounded-lg bg-alpha-100 text-[13px] text-gray-700">
          <ImageOff className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {id === null ? "That picture is not one of this note's" : "That picture is not on this device yet"}
        </span>
      ) : (
        <span aria-busy="true" className="block h-48 w-full animate-pulse rounded-lg bg-alpha-100" />
      )}
    </NodeViewWrapper>
  );
}
