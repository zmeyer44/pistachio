/**
 * Editing a bookmark's fields: the same form on the card over the page
 * (compact — the fields a glance would fix) and on the bookmarks page
 * (full — the address and picture too). It owns a draft and hands back a
 * patch; who saves it, and where, is the caller's business, so the card's
 * own renderer can use it without the shell's store.
 */

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import {
  BOOKMARK_KIND_LABEL,
  BOOKMARK_KINDS,
  MAX_BOOKMARK_DESCRIPTION,
  MAX_BOOKMARK_NOTE,
  MAX_BOOKMARK_TITLE,
  type Bookmark,
  type BookmarkKind,
  type BookmarkPatch,
} from "@pistachio/shell-contracts/bookmarks";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";

const KIND_ITEMS = BOOKMARK_KINDS.map((kind) => ({ value: kind, label: BOOKMARK_KIND_LABEL[kind] }));

export function BookmarkEditor({
  bookmark,
  compact = false,
  onSave,
  onCancel,
  className,
}: {
  bookmark: Bookmark;
  /** The card's form: title, kind, note, description. The page adds the rest. */
  compact?: boolean;
  /** Resolves with the error to show, or null when saved. */
  onSave(patch: BookmarkPatch): Promise<string | null>;
  onCancel(): void;
  className?: string;
}) {
  const [title, setTitle] = useState(bookmark.title);
  const [kind, setKind] = useState<BookmarkKind>(bookmark.kind);
  const [description, setDescription] = useState(bookmark.description);
  const [keywords, setKeywords] = useState(bookmark.keywords.join(", "));
  const [note, setNote] = useState(bookmark.note);
  const [imageUrl, setImageUrl] = useState(bookmark.imageUrl ?? "");
  const [url, setUrl] = useState(bookmark.url);
  const [siteName, setSiteName] = useState(bookmark.siteName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      titleRef.current?.focus();
      titleRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = async (): Promise<void> => {
    if (saving) return;
    const patch: BookmarkPatch = {};
    if (title.trim() !== bookmark.title) patch.title = title.trim();
    if (kind !== bookmark.kind) patch.kind = kind;
    if (description.trim() !== bookmark.description) patch.description = description.trim();
    const nextKeywords = keywords
      .split(/[,\n]/)
      .map((keyword) => keyword.trim().toLowerCase())
      .filter((keyword) => keyword !== "");
    const sameKeywords = nextKeywords.length === bookmark.keywords.length && nextKeywords.every((keyword, index) => keyword === bookmark.keywords[index]);
    if (!sameKeywords) patch.keywords = nextKeywords;
    if (note.trim() !== bookmark.note) patch.note = note.trim();
    if (!compact) {
      const nextImage = imageUrl.trim() === "" ? null : imageUrl.trim();
      if (nextImage !== bookmark.imageUrl) patch.imageUrl = nextImage;
      if (url.trim() !== bookmark.url && url.trim() !== "") patch.url = url.trim();
      if (siteName.trim() !== bookmark.siteName) patch.siteName = siteName.trim();
    }
    if (title.trim() === "") {
      setError("Give it a name.");
      return;
    }
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    const failure = await onSave(patch);
    setSaving(false);
    if (failure !== null) setError(failure);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className={cn("flex flex-col gap-2.5", className)}
      data-testid="bookmark-editor"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className={cn("grid gap-2.5", compact ? "grid-cols-[1fr_128px]" : "grid-cols-[1fr_160px]")}>
        <Input
          ref={titleRef}
          size="sm"
          label={compact ? undefined : "Title"}
          aria-label="Title"
          value={title}
          maxLength={MAX_BOOKMARK_TITLE}
          placeholder="What is it?"
          onChange={(event) => setTitle(event.target.value)}
          error={error}
        />
        <div className={cn("flex flex-col gap-1.5", compact ? "" : "pt-0")}>
          {compact ? null : <span className="text-label-13 text-gray-1000">Kind</span>}
          <Select value={kind} items={KIND_ITEMS} onValueChange={setKind} aria-label="Kind" className="w-full" />
        </div>
      </div>
      <Textarea
        aria-label="Description"
        value={description}
        maxLength={MAX_BOOKMARK_DESCRIPTION}
        placeholder="A line or two on what it is"
        rows={compact ? 2 : 3}
        className={cn("text-copy-13", compact ? "min-h-14 py-1.5" : "min-h-20")}
        onChange={(event) => setDescription(event.target.value)}
      />
      <Input
        size="sm"
        label={compact ? undefined : "Keywords"}
        aria-label="Keywords"
        value={keywords}
        placeholder="Keywords, separated by commas"
        description={compact ? undefined : "What you would type to find it again."}
        onChange={(event) => setKeywords(event.target.value)}
      />
      <Textarea
        aria-label="Note"
        value={note}
        maxLength={MAX_BOOKMARK_NOTE}
        placeholder="A note to yourself — why you kept it"
        rows={compact ? 1 : 2}
        className={cn("text-copy-13", compact ? "min-h-9 py-1.5" : "min-h-14")}
        onChange={(event) => setNote(event.target.value)}
      />
      {compact ? null : (
        <>
          <Input size="sm" label="Site" value={siteName} placeholder="Where it is from" onChange={(event) => setSiteName(event.target.value)} />
          <Input size="sm" label="Image URL" value={imageUrl} placeholder="https://…" inputMode="url" onChange={(event) => setImageUrl(event.target.value)} />
          <Input size="sm" label="Address" value={url} inputMode="url" onChange={(event) => setUrl(event.target.value)} />
        </>
      )}
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <Button type="button" variant="tertiary" size="xs" prefix={<X aria-hidden="true" />} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" prefix={<Check aria-hidden="true" />} loading={saving} data-testid="bookmark-editor-save">
          Save
        </Button>
      </div>
    </form>
  );
}
