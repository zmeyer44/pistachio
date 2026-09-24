/**
 * The notes the shell holds, and the only place that talks to the host about
 * them (docs/notes.md §4, §5). Its own zustand store beside the shell's, like
 * `reports/use-brief.ts`: the library, an editor, the palette and the home
 * page's teaser all read this one copy, so opening a note twice asks once.
 *
 * Two shapes are kept apart on purpose. `summaries` is what `onNotes` carries
 * — metadata only, so five hundred notes never serialise their markdown on a
 * keystroke — and `notes` holds the bodies of the ones actually opened.
 *
 * Nothing here throws into React. A host that will never answer (a cloud
 * session before stage 2) sets `unsupported` and is left alone; anything else
 * lands in `error` and is shown as a fault, which is the store's own rule
 * about refusals (src/store.ts `noteRefusal`).
 */

import { create } from "zustand";
import { noteSnippet, type Note, type NoteBlobMediaType, type NoteHosting, type NoteInput, type NotePatch, type NoteShare, type NoteSummary } from "@pistachio/shell-contracts/notes";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";
import { shellApi } from "../../api";
import { bytesToBase64 } from "../../lib/notes-images";
import { useAppStore } from "../../store";

interface NotesState {
  /** Every note's metadata, newest edit first. Null until the first list. */
  summaries: NoteSummary[] | null;
  /** The bodies of the notes that have been opened. */
  notes: Record<string, Note>;
  /** `note-blob:<id>` resolved to something an `<img>` can load. */
  blobUrls: Record<string, string>;
  /**
   * Where each note is published, once asked (docs/notes.md §8). `null` means
   * a note this Mac cannot publish at all — no account — and is what the
   * Share menu says "sign in" for; a missing entry means nobody has asked yet.
   */
  hosting: Record<string, NoteHosting | null>;
  /**
   * Who each note is shared with, once asked (docs/notes.md §9). `null` is
   * the same "not on this Mac" a null `hosting` is; a missing entry means
   * nobody has asked yet.
   */
  shares: Record<string, NoteShare[] | null>;
  /** This host has no notes and never will (a cloud session, stage 2). */
  unsupported: boolean;
  /** The last refusal that was not `unsupported`. */
  error: string | null;
  load(): Promise<void>;
  open(id: string): Promise<Note | null>;
  create(input?: NoteInput): Promise<Note | null>;
  save(id: string, patch: NotePatch): Promise<Note | null>;
  remove(id: string): Promise<boolean>;
  search(query: string, limit?: number): Promise<NoteSummary[]>;
  /** Keep an image's bytes; answers the blob id, with its object URL cached. */
  putImage(bytes: Uint8Array, mediaType: NoteBlobMediaType): Promise<string | null>;
  /** The object URL for a blob, fetching it the first time it is asked for. */
  blobUrl(id: string): Promise<string | null>;
  /** Read where this note is published. Null: nowhere, or nowhere possible. */
  sharing(id: string): Promise<NoteHosting | null>;
  /** Publish this note as it stands, or revoke the link. */
  setVisibility(id: string, visibility: "private" | "public"): Promise<NoteHosting | null>;
  /** Read who this note is shared with (§9). */
  loadShares(id: string): Promise<NoteShare[] | null>;
  /**
   * Share with, or change the role of, one account named by its email.
   * `found` is false when no Pistachio account holds that address — the one
   * outcome control deliberately does not distinguish with a status, so the
   * panel is what says it.
   */
  share(id: string, email: string, role: "viewer" | "editor"): Promise<{ found: boolean }>;
  /** End one share. */
  unshare(id: string, shareId: string): Promise<void>;
}

/** One subscription per window, whatever mounts first. */
let subscribed = false;
/** Blobs already being fetched: a note with the same picture twice asks once. */
const fetching = new Map<string, Promise<string | null>>();

function byRecency(notes: NoteSummary[]): NoteSummary[] {
  return [...notes].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * Every call goes through here: the refusal lands in this store AND in the
 * shell's maps, so a settings page or a menu can see that this host does not
 * do notes without asking again.
 */
function refuse(cause: unknown, fallback: string): void {
  useAppStore.getState().noteRefusal("notes", cause);
  if (isShellUnsupported(cause)) {
    useNotes.setState({ unsupported: true });
    return;
  }
  useNotes.setState({ error: cause instanceof Error ? cause.message : fallback });
}

export const useNotes = create<NotesState>((set, get) => ({
  summaries: null,
  notes: {},
  blobUrls: {},
  hosting: {},
  shares: {},
  unsupported: false,
  error: null,

  load: async () => {
    if (get().unsupported) return;
    try {
      const response = await shellApi().notes({ type: "list" });
      if (response.type !== "list") return;
      set({ summaries: byRecency(response.notes), error: null });
    } catch (error) {
      refuse(error, "Your notes could not be read.");
      return;
    }
    // Subscribed only after a list answered: a host that refuses the read
    // will refuse the subscription too, and one refusal is enough.
    if (subscribed) return;
    subscribed = true;
    try {
      shellApi().onNotes((snapshot) => set({ summaries: byRecency(snapshot.notes) }));
    } catch (error) {
      subscribed = false;
      refuse(error, "Your notes could not be followed.");
    }
  },

  open: async (id) => {
    try {
      const response = await shellApi().notes({ type: "get", id });
      const note = response.type === "maybeNote" ? response.note : response.type === "note" ? response.note : null;
      if (note !== null) set((state) => ({ notes: { ...state.notes, [note.id]: note }, error: null }));
      return note;
    } catch (error) {
      refuse(error, "That note could not be opened.");
      return null;
    }
  },

  create: async (input) => {
    try {
      const response = await shellApi().notes(input === undefined ? { type: "create" } : { type: "create", input });
      if (response.type !== "note") return null;
      const note = response.note;
      set((state) => ({
        notes: { ...state.notes, [note.id]: note },
        // The subscription will say the same thing; this is so the library
        // has the row before the round trip lands.
        summaries: byRecency([...(state.summaries ?? []).filter((s) => s.id !== note.id), summaryOf(note)]),
        error: null,
      }));
      return note;
    } catch (error) {
      refuse(error, "That note could not be made.");
      return null;
    }
  },

  save: async (id, patch) => {
    try {
      const response = await shellApi().notes({ type: "update", id, patch });
      if (response.type !== "note") return null;
      const note = response.note;
      set((state) => ({ notes: { ...state.notes, [note.id]: note }, error: null }));
      return note;
    } catch (error) {
      refuse(error, "That note could not be saved.");
      return null;
    }
  },

  remove: async (id) => {
    try {
      await shellApi().notes({ type: "delete", id });
      set((state) => {
        const notes = { ...state.notes };
        delete notes[id];
        return { notes, summaries: (state.summaries ?? []).filter((note) => note.id !== id), error: null };
      });
      return true;
    } catch (error) {
      refuse(error, "That note could not be deleted.");
      return false;
    }
  },

  search: async (query, limit) => {
    try {
      const response = await shellApi().notes(limit === undefined ? { type: "search", query } : { type: "search", query, limit });
      return response.type === "list" ? response.notes : [];
    } catch (error) {
      refuse(error, "Your notes could not be searched.");
      return [];
    }
  },

  putImage: async (bytes, mediaType) => {
    try {
      const response = await shellApi().notes({ type: "putBlob", mediaType, data: bytesToBase64(bytes) });
      if (response.type !== "blobId") return null;
      const id = response.id;
      // Cached from the bytes we already hold, so the picture draws in the
      // same frame it is inserted rather than after a round trip back.
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mediaType }));
      set((state) => {
        const existing = state.blobUrls[id];
        if (existing !== undefined) {
          URL.revokeObjectURL(url);
          return {};
        }
        return { blobUrls: { ...state.blobUrls, [id]: url }, error: null };
      });
      return id;
    } catch (error) {
      refuse(error, "That picture could not be kept.");
      return null;
    }
  },

  blobUrl: async (id) => {
    const cached = get().blobUrls[id];
    if (cached !== undefined) return cached;
    const running = fetching.get(id);
    if (running !== undefined) return running;
    const request = (async () => {
      try {
        const response = await shellApi().notes({ type: "getBlob", id });
        const blob = response.type === "blob" ? response.blob : null;
        if (blob === null) return null;
        const bytes = Uint8Array.from(atob(blob.data), (character) => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: blob.mediaType }));
        set((state) => {
          const existing = state.blobUrls[id];
          if (existing !== undefined) {
            URL.revokeObjectURL(url);
            return {};
          }
          return { blobUrls: { ...state.blobUrls, [id]: url } };
        });
        return get().blobUrls[id] ?? url;
      } catch (error) {
        refuse(error, "That picture could not be read.");
        return null;
      } finally {
        fetching.delete(id);
      }
    })();
    fetching.set(id, request);
    return request;
  },

  sharing: async (id) => {
    try {
      const response = await shellApi().notes({ type: "sharing", id });
      const hosting = response.type === "sharing" ? response.hosting : null;
      set((state) => ({ hosting: { ...state.hosting, [id]: hosting }, error: null }));
      return hosting;
    } catch (error) {
      refuse(error, "Sharing could not be read for that note.");
      return null;
    }
  },

  setVisibility: async (id, visibility) => {
    try {
      const response = await shellApi().notes({ type: "setVisibility", id, visibility });
      const hosting = response.type === "sharing" ? response.hosting : null;
      set((state) => ({ hosting: { ...state.hosting, [id]: hosting }, error: null }));
      return hosting;
    } catch (error) {
      refuse(error, visibility === "public" ? "That note could not be published." : "That link could not be revoked.");
      return null;
    }
  },

  loadShares: async (id) => {
    try {
      const response = await shellApi().notes({ type: "shares", id });
      const shares = response.type === "shares" ? response.shares : null;
      set((state) => ({ shares: { ...state.shares, [id]: shares }, error: null }));
      return shares;
    } catch (error) {
      refuse(error, "Who this note is shared with could not be read.");
      return null;
    }
  },

  share: async (id, email, role) => {
    try {
      const response = await shellApi().notes({ type: "share", id, email, role });
      if (response.type !== "shares") return { found: false };
      set((state) => ({ shares: { ...state.shares, [id]: response.shares }, error: null }));
      return { found: response.found };
    } catch (error) {
      refuse(error, "That note could not be shared.");
      return { found: false };
    }
  },

  unshare: async (id, shareId) => {
    try {
      const response = await shellApi().notes({ type: "unshare", id, shareId });
      if (response.type !== "shares") return;
      set((state) => ({ shares: { ...state.shares, [id]: response.shares }, error: null }));
    } catch (error) {
      refuse(error, "That share could not be ended.");
    }
  },
}));

/**
 * A summary as the pure search wants it (`searchNotes` takes `Note`s). The
 * snippet stands in for the body: the library and the palette hold metadata
 * only, so what they can match on is what they were given. Searching INSIDE a
 * note is the open note's job, and the agent's `note_search`.
 */
export function summaryAsNote(summary: NoteSummary): Note {
  return { ...summary, markdown: summary.snippet };
}

/**
 * A note as the library lists it, so a row exists the moment it is made
 * rather than one round trip later. The host's own snapshot says the same
 * thing a moment afterwards, through the same `noteSnippet`.
 */
function summaryOf(note: Note): NoteSummary {
  const { markdown, ...rest } = note;
  return { ...rest, snippet: noteSnippet(markdown) };
}
