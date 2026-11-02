/**
 * A picture inside a note. Its `src` is either `note-blob:<id>` (N3) — an
 * address only the host can resolve, through `NoteEditorHost.blobUrl` — or
 * a web address, shown from where it is. A register the host does not hold,
 * or cannot reach from here, is said quietly in a box of the picture's own.
 *
 * ProseMirror reuses this view when a node's attributes change (undo, a
 * remote revision), so what is resolved is kept BY ID: a view handed a
 * different picture resolves again rather than keep showing the old one.
 */

import { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { ImageOff } from "lucide-react";
import { cn } from "../cn";
import { useNoteHost } from "../host";

/** `note-blob:<24 hex>` → the id, or null for anything else. */
export function blobIdOf(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const match = /^note-blob:([a-f0-9]{24})$/u.exec(src.trim());
  return match === null ? null : match[1]!;
}

/** A web address a picture may be shown from, or null. */
function webSrcOf(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const value = src.trim();
  return /^https?:\/\/\S+$/iu.test(value) ? value : null;
}

/** What the host answered for one register: an address, or null for one it does not hold. */
interface Resolved {
  id: string;
  url: string | null;
}

export function ImageView({ node, selected }: ReactNodeViewProps) {
  const src = node.attrs["src"] as string | null;
  const alt = (node.attrs["alt"] as string | null) ?? "";
  const id = blobIdOf(src);
  const web = id === null ? webSrcOf(src) : null;
  const host = useNoteHost();
  const reachable = host.blobUrl !== undefined;
  // Asked once per id. A host that has the picture answers at once and
  // nothing flickers; one that has to fetch it answers a promise, kept here
  // so that an effect replayed in development (StrictMode) subscribes to
  // the same request rather than finding nothing to wait for.
  const asked = useRef<{ id: string; answer: string | null | Promise<string | null> } | null>(null);
  const ask = (wanted: string): string | null | Promise<string | null> => {
    if (asked.current?.id !== wanted) asked.current = { id: wanted, answer: host.blobUrl === undefined ? null : host.blobUrl(wanted) };
    return asked.current.answer;
  };
  const [resolved, setResolved] = useState<Resolved | null>(() => {
    if (id === null) return null;
    const answer = ask(id);
    return answer instanceof Promise ? null : { id, url: answer };
  });

  useEffect(() => {
    if (id === null || resolved?.id === id) return;
    const answer = ask(id);
    if (!(answer instanceof Promise)) {
      setResolved({ id, url: answer });
      return;
    }
    let live = true;
    void answer.then((url) => {
      if (live) setResolved({ id, url });
    });
    return () => {
      live = false;
    };
    // `ask` reads refs and the host; the id is the only thing that changes what is asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, resolved]);

  // A picture the host did not hold may arrive — synced from another device,
  // resolved in another pane — so a missing one asks again when the host
  // says its pictures changed, rather than staying missing until remounted.
  useEffect(() => {
    if (id === null || resolved?.id !== id || resolved.url !== null || host.subscribeBlobs === undefined) return;
    return host.subscribeBlobs(() => {
      asked.current = null;
      setResolved(null);
    });
  }, [id, resolved, host]);

  // What to draw: a picture, a word about one that is not here, or a box while it is fetched.
  let shown: string | null = web;
  let label: string | null = null;
  if (id !== null) {
    const answer = resolved?.id === id ? resolved : null;
    if (answer === null) shown = null;
    else if (answer.url !== null) shown = answer.url;
    else label = reachable ? "That picture is not on this device yet" : "This picture stays on the owner's devices";
  } else if (web === null) {
    label = "That picture is not one of this note's";
  }

  return (
    <NodeViewWrapper
      as="figure"
      data-testid="note-image"
      data-blob-id={id ?? undefined}
      className={cn("my-4 overflow-hidden rounded-lg", selected && "ring-2 ring-ring")}
    >
      {shown !== null ? (
        <img src={shown} alt={alt} draggable={false} loading="lazy" referrerPolicy="no-referrer" className="block max-w-full rounded-lg" />
      ) : label !== null ? (
        <span className="flex h-24 items-center justify-center gap-2 rounded-lg bg-alpha-100 text-[13px] text-gray-700">
          <ImageOff className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {label}
        </span>
      ) : (
        <span aria-busy="true" className="block h-48 w-full animate-pulse rounded-lg bg-alpha-100" />
      )}
    </NodeViewWrapper>
  );
}
