/**
 * Sharing one note (docs/notes.md §8 for the link, §9 for the people).
 *
 * The panel that hangs off the editor's `…` menu, and the only place in the
 * shell that publishes anything. It says three things, depending on what the
 * host answered:
 *
 *   - no account: sharing is not a thing this Mac can do, and the panel says
 *     so in one line rather than offering a button that would fail;
 *   - private: one button, and then a sentence naming exactly what becomes
 *     public before the button is real. Publishing is a decision, not a
 *     toggle you can brush past;
 *   - public: the address, copy, open, and the way back to private.
 *
 * What is published is finished HTML the desktop rendered from this note —
 * control never sees markdown (N9) — and it is the note as it stands at the
 * moment of publishing; later edits chase it from the main process.
 *
 * Under it, "People" (§9): the accounts this note is shared with by name,
 * and what each may do. That half is NOT the link. A named viewer or editor
 * reads the note's text on the web, which means its text is kept in
 * plaintext on Pistachio's servers for as long as the share stands — the one
 * sentence under the list says exactly that, because nothing else in the
 * product makes that trade without saying so.
 */

import { useEffect, useState, type FormEvent } from "react";
import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import { Check, Copy, ExternalLink, Globe2, LoaderCircle, LockKeyhole, X } from "lucide-react";
import type { NoteShare } from "@pistachio/shell-contracts/notes";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store";
import { FOCUS, PILL } from "./parts";
import { useNotes } from "./use-notes";

/** How long "Copied" stands before the button goes back to being a button. */
const COPIED_MS = 2_000;

const FIELD = cn(
  "h-[30px] w-full min-w-0 rounded-lg bg-alpha-100 px-2.5 text-[12.5px] text-gray-1000 outline-none placeholder:text-gray-700",
  FOCUS,
);

const PRIMARY = cn(
  "flex h-[30px] w-full cursor-pointer items-center justify-center gap-1.5 rounded-full bg-gray-1000 px-3 text-[13px] leading-[20px] font-medium text-background-100 transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40",
  FOCUS,
);

export function ShareMenu({
  noteId,
  anchor,
  onClose,
}: {
  noteId: string;
  /** The `…` button the panel hangs off; null until the bar has mounted. */
  anchor: HTMLElement | null;
  onClose(): void;
}) {
  const enrolled = useAppStore((state) => state.account.state === "enrolled");
  const hosting = useNotes((state) => state.hosting[noteId]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: "bottom-end",
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    elements: { reference: anchor ?? undefined },
  });

  // Asked once per opening: a hosting row can change on another device, and
  // what this panel shows has to be what control says right now.
  useEffect(() => {
    if (!enrolled) {
      setLoading(false);
      return;
    }
    let live = true;
    void useNotes
      .getState()
      .sharing(noteId)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enrolled, noteId]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (refs.floating.current?.contains(target) === true || anchor?.contains(target) === true) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    // `onClose` is the editor's own setter; re-binding on every render of the
    // parent would tear these listeners down mid-gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, refs.floating]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const change = (visibility: "private" | "public") => {
    setBusy(true);
    setConfirming(false);
    void useNotes
      .getState()
      .setVisibility(noteId, visibility)
      .finally(() => setBusy(false));
  };

  const url = hosting?.visibility === "public" ? hosting.publicUrl : null;

  return (
    <div
      ref={refs.setFloating}
      data-testid="note-share"
      data-state={!enrolled ? "signed-out" : url !== null ? "public" : "private"}
      style={floatingStyles}
      className="z-50 w-[320px] rounded-xl bg-background-100 p-3 text-gray-1000 shadow-menu"
    >
      {!enrolled ? (
        <p className="text-[12.5px] leading-[18px] text-gray-800">Sign in to share notes on the web.</p>
      ) : loading ? (
        <p className="flex items-center gap-1.5 text-[12.5px] leading-[18px] text-gray-800">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          Checking where this note is published…
        </p>
      ) : url === null ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-[12.5px] leading-[18px] text-gray-800">
            {confirming
              ? "Anyone with the link can read this note. Pictures are included."
              : "This note is private to your account."}
          </p>
          {confirming ? (
            <div className="flex gap-2">
              <button type="button" className={cn(PILL, "flex-1 justify-center")} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="note-share-confirm"
                className={cn(PRIMARY, "flex-1")}
                disabled={busy}
                onClick={() => change("public")}
              >
                <Globe2 className="size-3.5" aria-hidden="true" />
                Publish
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="note-share-publish"
              className={PRIMARY}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <Globe2 className="size-3.5" aria-hidden="true" />
              Publish to web
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <p className="text-[12.5px] leading-[18px] text-gray-800">Anyone with this link can read this note.</p>
          <input
            type="text"
            readOnly
            aria-label="Public link"
            data-testid="note-share-url"
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className={cn(
              "h-[30px] w-full rounded-lg bg-alpha-100 px-2.5 text-[12.5px] text-gray-900 outline-none select-all",
              FOCUS,
            )}
          />
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="note-share-copy"
              className={cn(PILL, "flex-1 justify-center")}
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => setCopied(true));
              }}
            >
              {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              data-testid="note-share-open"
              className={cn(PILL, "flex-1 justify-center")}
              onClick={() => void useAppStore.getState().createTab(url)}
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              Open
            </button>
          </div>
          <button
            type="button"
            data-testid="note-share-private"
            className={cn(PILL, "justify-center")}
            disabled={busy}
            onClick={() => change("private")}
          >
            <LockKeyhole className="size-3.5" aria-hidden="true" />
            Make private
          </button>
        </div>
      )}
      {!enrolled ? null : (
        <>
          <hr className="my-3 border-0 border-t border-alpha-200" />
          <People noteId={noteId} />
        </>
      )}
    </div>
  );
}

/**
 * The accounts named on this note (docs/notes.md §9). A share is made by
 * exact email against an account that already exists — there are no invites
 * to strangers — so the one thing this has to say clearly, and the one thing
 * control refuses to distinguish with a status code, is that an address
 * matched nothing.
 */
function People({ noteId }: { noteId: string }) {
  const shares = useNotes((state) => state.shares[noteId]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void useNotes
      .getState()
      .loadShares(noteId)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [noteId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (address === "" || busy) return;
    setBusy(true);
    setResult(null);
    void useNotes
      .getState()
      .share(noteId, address, role)
      .then(({ found }) => {
        setResult(found ? `Shared with ${address}` : "No Pistachio account with that email.");
        if (found) setEmail("");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2.5" data-testid="note-people">
      <p className="text-[12.5px] leading-[18px] font-medium text-gray-1000">People</p>
      {loading ? (
        <p className="flex items-center gap-1.5 text-[12.5px] leading-[18px] text-gray-800">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          Checking who this note is shared with…
        </p>
      ) : shares === undefined || shares === null || shares.length === 0 ? (
        <p className="text-[12.5px] leading-[18px] text-gray-800">Not shared with anyone yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shares.map((share: NoteShare) => (
            <li key={share.id} className="flex items-center gap-1.5" data-testid="note-person">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-1000" title={share.email}>
                {share.email}
              </span>
              <select
                aria-label={`What ${share.email} may do`}
                value={share.role}
                disabled={busy}
                onChange={(event) => {
                  setBusy(true);
                  setResult(null);
                  void useNotes
                    .getState()
                    .share(noteId, share.email, event.target.value === "editor" ? "editor" : "viewer")
                    .finally(() => setBusy(false));
                }}
                className={cn("h-[26px] shrink-0 cursor-pointer rounded-lg bg-alpha-100 px-1.5 text-[12px] text-gray-900 outline-none", FOCUS)}
              >
                <option value="viewer">Can view</option>
                <option value="editor">Can edit</option>
              </select>
              <button
                type="button"
                aria-label={`Stop sharing with ${share.email}`}
                data-testid="note-person-remove"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setResult(null);
                  void useNotes.getState().unshare(noteId, share.id).finally(() => setBusy(false));
                }}
                className={cn(
                  "grid size-[26px] shrink-0 cursor-pointer place-items-center rounded-lg text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-1000 disabled:cursor-default disabled:opacity-60",
                  FOCUS,
                )}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-1.5" onSubmit={submit}>
        <input
          type="email"
          aria-label="Email address to share with"
          data-testid="note-person-email"
          placeholder="name@example.com"
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
          className={FIELD}
        />
        <select
          aria-label="What they may do"
          value={role}
          disabled={busy}
          onChange={(event) => setRole(event.target.value === "editor" ? "editor" : "viewer")}
          className={cn("h-[30px] shrink-0 cursor-pointer rounded-lg bg-alpha-100 px-1.5 text-[12px] text-gray-900 outline-none", FOCUS)}
        >
          <option value="viewer">Can view</option>
          <option value="editor">Can edit</option>
        </select>
        <button type="submit" data-testid="note-person-share" className={cn(PILL, "shrink-0")} disabled={busy || email.trim() === ""}>
          Share
        </button>
      </form>
      {result === null ? null : (
        <p className="text-[12.5px] leading-[18px] text-gray-800" data-testid="note-person-result">
          {result}
        </p>
      )}
      <p className="text-[11.5px] leading-[16px] text-gray-700">
        People you share with can read this note on the web; its text is stored on Pistachio&apos;s servers for them.
      </p>
    </div>
  );
}
