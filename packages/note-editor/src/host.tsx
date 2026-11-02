/**
 * What the editor asks of the app around it (docs/notes.md §5). The surface
 * is the same on the desktop, in the web shell and on the account site;
 * what differs is where a link opens, where a note's own pictures are, who
 * can take a dropped file, and whether a widget's document can be served
 * from an address of its own. Each is optional, and each absence has a
 * meaning the editor says out loud rather than fails on.
 */

import { createContext, useContext } from "react";

export interface NoteEditorHost {
  /**
   * Open a link the person asked for — Mod-click on one, the link editor's
   * Open, an embed's Open. Absent: a new browsing context, no opener.
   */
  openLink?(href: string, box: DOMRect): void;
  /**
   * A note's own picture (`note-blob:<id>`, N3) as something an `<img>` can
   * show: an address, `null` for one this device does not hold, or a promise
   * of either while it is fetched. Absent: the register is not reachable
   * from here at all (a shared note on the web), and the picture is drawn as
   * staying on the owner's devices.
   */
  blobUrl?(id: string): string | null | Promise<string | null>;
  /**
   * Be told when the host's pictures change — one arrived, one was kept, one
   * was resolved in another pane — so a picture drawn as missing asks again.
   * Answers the unsubscribe. Absent: a missing picture stays missing until
   * the view is mounted again.
   */
  subscribeBlobs?(listener: () => void): () => void;
  /**
   * Take one picture file the person dropped, pasted or picked, and answer
   * the `src` to insert — `note-blob:<id>` once the host keeps it — or
   * `null` for one it refused (the host says why, in its own bar). Absent:
   * files are not taken, and the Image row asks for an address only.
   */
  uploadImage?(file: File): Promise<string | null>;
  /**
   * Where a widget's document is served under its own policy, when the page
   * holding the editor forbids inline script (the desktop shell). Absent: the
   * frame holds the document itself (`srcdoc`), under the page's policy.
   */
  frameSrc?(document: string): string;
}

const NoteHostContext = createContext<NoteEditorHost>({});

export const NoteHostProvider = NoteHostContext.Provider;

export function useNoteHost(): NoteEditorHost {
  return useContext(NoteHostContext);
}

/** The link opener a host that names none gets: a new context, no opener. */
export function openLinkElsewhere(href: string): void {
  window.open(href, "_blank", "noopener,noreferrer");
}
