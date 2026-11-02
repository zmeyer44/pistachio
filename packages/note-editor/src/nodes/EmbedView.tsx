/**
 * An embed in the editor: a sandboxed frame for a YouTube, Loom, Vimeo,
 * Figma or any https link, with a caption naming where it is from. Empty, it
 * is a field asking for the link.
 */

import { EMBED_ALLOW, EMBED_SANDBOX, resolveEmbed, sanitizeEmbedSrc } from "@pistachio/notes";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { ArrowUpRight, Globe, Pencil } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { cn } from "../cn";
import { openLinkElsewhere, useNoteHost } from "../host";
import { FOCUS } from "../parts";
import { focusAfterNode } from "./focus-after";
import { useIsEditable } from "./use-is-editable";

function validate(input: string): { src: string } | { error: string } {
  const src = sanitizeEmbedSrc(input);
  if (src === null) return { error: "Enter a valid https:// link." };
  // A frame of our own origin with allow-same-origin could script the shell.
  if (new URL(src).origin === window.location.origin) return { error: "Links to this app can't be embedded." };
  return { src };
}

const ACTION = cn("inline-flex cursor-pointer items-center gap-1 text-[12.5px] text-gray-700 transition-colors hover:text-gray-1000 [&_svg]:size-3.5", FOCUS);

export function EmbedView({ node, editor, getPos, selected, updateAttributes, deleteNode }: ReactNodeViewProps) {
  const src = (node.attrs["src"] as string | undefined) ?? "";
  const target = resolveEmbed(src);
  const editable = useIsEditable(editor);
  const host = useNoteHost();
  const [editing, setEditing] = useState(target === null);
  const [draft, setDraft] = useState(src);
  const [error, setError] = useState<string | null>(null);
  // Undo, redo and a remote revision change the source underneath, and the
  // view is reused: what it shows follows the node, not its first render.
  const [syncedSrc, setSyncedSrc] = useState(src);
  if (src !== syncedSrc) {
    setSyncedSrc(src);
    setDraft(src);
    setEditing(target === null);
    setError(null);
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validate(draft);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    updateAttributes({ src: result.src });
    setEditing(false);
    focusAfterNode(editor, getPos, node);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (target !== null) {
      setDraft(src);
      setEditing(false);
      focusAfterNode(editor, getPos, node);
    } else {
      deleteNode();
      editor.commands.focus();
    }
  };

  if (editing || target === null) {
    return (
      <NodeViewWrapper className="note-embed note-embed--empty" data-type="embed" data-selected={selected ? "" : undefined} data-testid="note-embed">
        <form className="note-embed__form" contentEditable={false} onSubmit={submit}>
          <Globe className="note-embed__icon" aria-hidden="true" />
          <input
            className="note-embed__input"
            autoFocus={editable}
            disabled={!editable}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Paste a YouTube, Loom, Figma or any https:// link"
            aria-label="Embed link"
            aria-invalid={error === null ? undefined : true}
            data-testid="note-embed-input"
          />
          <button
            type="submit"
            className={cn("h-[30px] cursor-pointer rounded-md bg-gray-1000 px-3 text-[14px] font-medium text-background-100 disabled:cursor-default disabled:opacity-40", FOCUS)}
            disabled={!editable || draft.trim() === ""}
          >
            Embed
          </button>
          {error === null ? null : <p className="note-embed__error">{error}</p>}
        </form>
      </NodeViewWrapper>
    );
  }

  const hostname = new URL(src).hostname.replace(/^www\./u, "");
  return (
    <NodeViewWrapper className="note-embed" data-type="embed" data-provider={target.provider} data-selected={selected ? "" : undefined} data-testid="note-embed">
      <div className="note-embed__frame" contentEditable={false}>
        <iframe
          src={target.embedUrl}
          title={`${target.provider === "Web" ? hostname : target.provider} embed`}
          sandbox={EMBED_SANDBOX}
          allow={EMBED_ALLOW}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      <div className="note-embed__caption" contentEditable={false}>
        <span className="mr-auto">{hostname}</span>
        <button
          type="button"
          className={ACTION}
          onClick={(event) => {
            if (host.openLink === undefined) openLinkElsewhere(src);
            else host.openLink(src, event.currentTarget.getBoundingClientRect());
          }}
        >
          Open <ArrowUpRight aria-hidden="true" />
        </button>
        {editable ? (
          <button type="button" className={ACTION} onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" /> Replace
          </button>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}
